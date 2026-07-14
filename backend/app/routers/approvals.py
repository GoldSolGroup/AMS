import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from ..db import prisma
from ..schemas import ActionRequestIn, ReviewIn
from ..serializers import action_request_to_dict, asset_to_dict
from ..auth import require_auth, require_mission_or_admin, user_mission_scope, TOP_ROLES

router = APIRouter(tags=["approvals"])

ASSET_INCLUDE = {"photos": True, "documents": True, "history": True, "disposals": True}


async def transfer_requires_hq(tenant_id: str, from_loc: str, to_loc: str) -> bool:
    """Fixed rule, no exceptions: any transfer between two different missions
    (including to/from Head Office) requires Head Office Admin or System
    Owner approval. Only a transfer within the same mission — or offboarding,
    which has no destination — is approvable at mission-admin level."""
    if not to_loc or from_loc == to_loc:
        return False
    return True


async def _authorize_review(user, req, asset):
    """System Owner / Head Office Admin can review anything. Mission Admin can
    only review requests for assets currently in their own mission, AND only
    if the transfer rules don't escalate it to Head Office (see
    transfer_requires_hq for the mission/region rules)."""
    if user.role in TOP_ROLES:
        return
    if user.role != "Mission Admin":
        raise HTTPException(status_code=403, detail="Administrator or Mission Admin access required")
    payload = json.loads(req.payload)
    if req.type == "Transfer" and not payload.get("offboard"):
        if await transfer_requires_hq(user.tenantId, asset.location, payload.get("newLocation")):
            raise HTTPException(status_code=403, detail="This transfer requires Head Office Admin or System Owner approval")
    user_mission_name = user.mission.name if getattr(user, "mission", None) else None
    if asset.location != user_mission_name:
        raise HTTPException(status_code=403, detail="You can only review requests for assets in your own mission")


@router.post("/assets/{asset_id}/action-requests")
async def create_action_request(asset_id: str, tenant_id: str, body: ActionRequestIn, user=Depends(require_auth)):
    if body.type not in ("Transfer", "Reclassification", "Fair Valuation"):
        raise HTTPException(status_code=400, detail="Unsupported action type")
    row = await prisma.actionrequest.create(data={
        "tenantId": tenant_id, "assetId": asset_id, "type": body.type,
        "payload": json.dumps(body.payload), "reason": body.reason,
        "requestedBy": user.fullName,
    })
    return action_request_to_dict(row)


@router.get("/action-requests")
async def list_action_requests(tenant_id: str, status: str | None = None, user=Depends(require_auth)):
    where = {"tenantId": tenant_id}
    if status:
        where["status"] = status
    rows = await prisma.actionrequest.find_many(where=where, order={"createdAt": "desc"})
    assets = await prisma.asset.find_many(where={"id": {"in": [r.assetId for r in rows]}}) if rows else []
    asset_map = {a.id: a for a in assets}

    scope = user_mission_scope(user)
    if scope is not None:
        if scope == "__NONE__":
            return []
        rows = [r for r in rows if (asset_map.get(r.assetId) and asset_map[r.assetId].location == scope)]
        if user.role == "Mission Admin":
            # Also hide anything this mission admin couldn't actually approve
            # (a cross-mission/cross-region transfer that needs Head Office).
            visible = []
            for r in rows:
                asset = asset_map.get(r.assetId)
                if r.type == "Transfer" and r.status == "Pending":
                    payload = json.loads(r.payload)
                    if not payload.get("offboard") and await transfer_requires_hq(tenant_id, asset.location, payload.get("newLocation")):
                        continue
                visible.append(r)
            rows = visible

    return [action_request_to_dict(r, asset_map.get(r.assetId)) for r in rows]


@router.post("/action-requests/{request_id}/approve")
async def approve_action_request(request_id: str, body: ReviewIn, user=Depends(require_mission_or_admin)):
    req = await prisma.actionrequest.find_unique(where={"id": request_id})
    if req is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.status != "Pending":
        raise HTTPException(status_code=409, detail=f"Request already {req.status.lower()}")
    asset_before = await prisma.asset.find_unique(where={"id": req.assetId})
    await _authorize_review(user, req, asset_before)

    payload = json.loads(req.payload)
    fields = {}
    history_note = req.reason or ""
    if req.type == "Transfer":
        if payload.get("offboard"):
            fields["location"] = None
            fields["custodian"] = None
            fields["room"] = None
            fields["status"] = "Available"
        else:
            if payload.get("newLocation") is not None: fields["location"] = payload["newLocation"]
            if payload.get("newCustodian") is not None: fields["custodian"] = payload["newCustodian"]
            if payload.get("newRoom") is not None: fields["room"] = payload["newRoom"]
            if asset_before.status == "Available" and payload.get("newLocation"):
                fields["status"] = "In Use"
    elif req.type == "Reclassification":
        if payload.get("newCategory") is not None: fields["category"] = payload["newCategory"]
    elif req.type == "Fair Valuation":
        if payload.get("value") is not None: fields["price"] = float(payload["value"])

    if fields:
        await prisma.asset.update(where={"id": req.assetId}, data=fields)
    await prisma.assethistory.create(data={
        "assetId": req.assetId, "type": req.type,
        "note": f"Approved: {history_note}" if history_note else "Approved",
        "actor": user.fullName,
    })
    updated_req = await prisma.actionrequest.update(where={"id": request_id}, data={
        "status": "Approved", "reviewedBy": user.fullName, "reviewNote": body.note,
        "reviewedAt": datetime.now(timezone.utc),
    })
    asset = await prisma.asset.find_unique(where={"id": req.assetId}, include=ASSET_INCLUDE)
    return {"request": action_request_to_dict(updated_req), "asset": asset_to_dict(asset)}


@router.post("/action-requests/{request_id}/reject")
async def reject_action_request(request_id: str, body: ReviewIn, user=Depends(require_mission_or_admin)):
    req = await prisma.actionrequest.find_unique(where={"id": request_id})
    if req is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.status != "Pending":
        raise HTTPException(status_code=409, detail=f"Request already {req.status.lower()}")
    asset = await prisma.asset.find_unique(where={"id": req.assetId})
    await _authorize_review(user, req, asset)

    await prisma.assethistory.create(data={
        "assetId": req.assetId, "type": req.type,
        "note": f"Rejected: {body.note or 'no reason given'}", "actor": user.fullName,
    })
    updated_req = await prisma.actionrequest.update(where={"id": request_id}, data={
        "status": "Rejected", "reviewedBy": user.fullName, "reviewNote": body.note,
        "reviewedAt": datetime.now(timezone.utc),
    })
    return {"request": action_request_to_dict(updated_req)}
