from datetime import datetime
from fastapi import APIRouter
from ..db import prisma
from ..schemas import CycleCreate, ScanIn, CloseCycleIn
from ..serializers import cycle_to_dict

router = APIRouter(prefix="/cycles", tags=["verification"])

CYCLE_INCLUDE = {"assets": True}


def parse_date(s):
    if not s:
        return None
    return datetime.fromisoformat(s)


@router.get("")
async def list_cycles(tenant_id: str):
    rows = await prisma.verificationcycle.find_many(where={"tenantId": tenant_id}, include=CYCLE_INCLUDE, order={"createdAt": "desc"})
    return [cycle_to_dict(r) for r in rows]


@router.post("")
async def create_cycle(tenant_id: str, body: CycleCreate):
    cycle = await prisma.verificationcycle.create(data={"tenantId": tenant_id, "scope": body.scope, "dueDate": parse_date(body.due)})
    if body.assetIds:
        for aid in body.assetIds:
            await prisma.verificationcycleasset.create(data={"cycleId": cycle.id, "assetId": aid})
    row = await prisma.verificationcycle.find_unique(where={"id": cycle.id}, include=CYCLE_INCLUDE)
    return cycle_to_dict(row)


@router.post("/{cycle_id}/scan")
async def scan(cycle_id: str, body: ScanIn):
    link = await prisma.verificationcycleasset.find_first(where={"cycleId": cycle_id, "assetId": body.assetId})
    if link is not None:
        await prisma.verificationcycleasset.update(where={"id": link.id}, data={"verified": True, "verifiedAt": datetime.utcnow(), "verifiedBy": body.verifiedBy})
    row = await prisma.verificationcycle.find_unique(where={"id": cycle_id}, include=CYCLE_INCLUDE)
    return cycle_to_dict(row)


@router.post("/{cycle_id}/close")
async def close_cycle(cycle_id: str, body: CloseCycleIn):
    await prisma.verificationcycle.update(where={"id": cycle_id}, data={"closed": True})
    if body.missingAssetIds:
        await prisma.asset.update_many(where={"id": {"in": body.missingAssetIds}}, data={"status": "Missing"})
    row = await prisma.verificationcycle.find_unique(where={"id": cycle_id}, include=CYCLE_INCLUDE)
    return cycle_to_dict(row)
