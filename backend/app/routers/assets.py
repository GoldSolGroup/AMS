from datetime import datetime
from fastapi import APIRouter, HTTPException, Depends
from ..db import prisma
from ..schemas import (
    AssetCreate, AssetUpdate, HistoryCreate, PhotoCreate, DocumentCreate,
    DisposalCreate, FairValueCreate, MergeAssetsIn, ReviewIn,
)
from ..serializers import asset_to_dict, asset_to_list_dict
from ..auth import require_auth, user_mission_scope, require_admin

router = APIRouter(prefix="/assets", tags=["assets"])

ASSET_INCLUDE = {"photos": True, "documents": True, "history": True, "disposals": True}
ASSET_LIST_INCLUDE = {"disposals": True, "_count": {"select": {"photos": True, "documents": True}}}


def parse_date(s):
    if not s:
        return None
    return datetime.fromisoformat(s)


@router.get("")
async def list_assets(tenant_id: str, user=Depends(require_auth)):
    where = {"tenantId": tenant_id}
    scope = user_mission_scope(user)
    if scope is not None:
        if scope == "__NONE__":
            return []
        where["location"] = scope
    # Lightweight on purpose — no photos/documents/history here, since those
    # can be large (photos especially) and this list loads on every visit to
    # the Register/Dashboard. Full detail is fetched per-asset on demand.
    rows = await prisma.asset.find_many(where=where, include=ASSET_LIST_INCLUDE, order={"createdAt": "desc"})
    return [asset_to_list_dict(r) for r in rows]


@router.get("/{asset_id}")
async def get_asset(asset_id: str):
    row = await prisma.asset.find_unique(where={"id": asset_id}, include=ASSET_INCLUDE)
    if row is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset_to_dict(row)


@router.post("")
async def create_asset(tenant_id: str, body: AssetCreate, user=Depends(require_auth)):
    scope = user_mission_scope(user)
    location = body.location or None
    if scope is not None:
        # Mission-scoped users can only capture assets into their own mission (never unassigned/other missions)
        if scope == "__NONE__":
            raise HTTPException(status_code=403, detail="You are not assigned to a mission yet — ask your administrator to assign one")
        location = scope

    dup = await prisma.asset.find_first(where={"tenantId": tenant_id, "barcode": body.barcode})
    if dup is None and body.serial:
        dup = await prisma.asset.find_first(where={"tenantId": tenant_id, "serial": body.serial})
    if dup is not None:
        raise HTTPException(status_code=409, detail={"duplicate": asset_to_dict(await prisma.asset.find_unique(where={"id": dup.id}, include=ASSET_INCLUDE))})

    scoa = body.scoa or None
    status = "In Use" if location else "Available"
    row = await prisma.asset.create(
        data={
            "tenantId": tenant_id, "barcode": body.barcode, "description": body.desc, "category": body.category,
            "location": location, "room": body.room, "custodian": body.custodian or None,
            "purchaseDate": parse_date(body.purchaseDate), "price": body.price, "currency": body.currency or "ZAR",
            "status": status, "costCentre": body.costCentre, "serial": body.serial,
            "poNumber": body.poNumber, "invoiceRef": body.invoiceRef,
            "fundingSource": body.fundingSource or "Voted Funds",
            "scoaFund": scoa.fund if scoa else None, "scoaFunction": scoa.func if scoa else None, "scoaItem": scoa.item if scoa else None,
        },
        include=ASSET_INCLUDE,
    )
    return asset_to_dict(row)


@router.patch("/{asset_id}")
async def update_asset(asset_id: str, body: AssetUpdate):
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    row = await prisma.asset.update(where={"id": asset_id}, data=data, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/history")
async def add_history(asset_id: str, body: HistoryCreate):
    await prisma.assethistory.create(data={"assetId": asset_id, "type": body.type, "note": body.note, "actor": body.actor or "System"})
    row = await prisma.asset.find_unique(where={"id": asset_id}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/photos")
async def add_photo(asset_id: str, body: PhotoCreate):
    await prisma.assetphoto.create(data={"assetId": asset_id, "url": body.url})
    row = await prisma.asset.find_unique(where={"id": asset_id}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/documents")
async def add_document(asset_id: str, body: DocumentCreate):
    await prisma.assetdocument.create(data={"assetId": asset_id, "name": body.name, "url": body.url})
    row = await prisma.asset.find_unique(where={"id": asset_id}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/disposal")
async def request_disposal(asset_id: str, body: DisposalCreate):
    await prisma.disposal.create(data={"assetId": asset_id, "method": body.method, "reason": body.reason, "value": body.value})
    row = await prisma.asset.update(where={"id": asset_id}, data={"status": "Pending Disposal Approval"}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/disposal/approve")
async def approve_disposal(asset_id: str, user=Depends(require_admin)):
    asset = await prisma.asset.find_unique(where={"id": asset_id})
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    pending = await prisma.disposal.find_first(where={"assetId": asset_id, "status": "Pending"}, order={"createdAt": "desc"})
    if pending is None:
        raise HTTPException(status_code=404, detail="No pending disposal for this asset")
    reference = "DISP-" + pending.id[-6:].upper()
    await prisma.disposal.update(where={"id": pending.id}, data={"status": "Approved", "reference": reference, "disposalDate": datetime.utcnow()})
    await prisma.assethistory.create(data={"assetId": asset_id, "type": "Disposal", "note": "Approved by Head Office", "actor": user.fullName})
    row = await prisma.asset.update(where={"id": asset_id}, data={"status": "Disposed"}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/disposal/reject")
async def reject_disposal(asset_id: str, body: ReviewIn, user=Depends(require_admin)):
    if not body.note or not body.note.strip():
        raise HTTPException(status_code=400, detail="A reason is required to decline a disposal request.")
    asset = await prisma.asset.find_unique(where={"id": asset_id})
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    pending = await prisma.disposal.find_first(where={"assetId": asset_id, "status": "Pending"}, order={"createdAt": "desc"})
    if pending is None:
        raise HTTPException(status_code=404, detail="No pending disposal for this asset")
    await prisma.disposal.update(where={"id": pending.id}, data={"status": "Rejected"})
    restored_status = "In Use" if (asset.custodian and asset.location) else "Available"
    await prisma.assethistory.create(data={"assetId": asset_id, "type": "Disposal", "note": f"Declined by Head Office: {body.note.strip()}", "actor": user.fullName})
    row = await prisma.asset.update(where={"id": asset_id}, data={"status": restored_status}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/{asset_id}/fair-value")
async def apply_fair_value(asset_id: str, body: FairValueCreate):
    await prisma.assethistory.create(data={"assetId": asset_id, "type": "Fair Valuation", "note": body.justification, "actor": body.actor or "System"})
    row = await prisma.asset.update(where={"id": asset_id}, data={"price": body.value}, include=ASSET_INCLUDE)
    return asset_to_dict(row)


@router.post("/merge")
async def merge_assets(body: MergeAssetsIn):
    for rid in body.removeIds:
        await prisma.assetphoto.update_many(where={"assetId": rid}, data={"assetId": body.keepId})
        await prisma.assetdocument.update_many(where={"assetId": rid}, data={"assetId": body.keepId})
        await prisma.assethistory.update_many(where={"assetId": rid}, data={"assetId": body.keepId})
        await prisma.assethistory.create(data={"assetId": body.keepId, "type": "Merge", "note": f"Merged duplicate {rid} into {body.keepId}", "actor": body.actor or "System"})
        await prisma.asset.delete(where={"id": rid})
    row = await prisma.asset.find_unique(where={"id": body.keepId}, include=ASSET_INCLUDE)
    return asset_to_dict(row)
