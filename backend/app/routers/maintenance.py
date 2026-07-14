from datetime import datetime
from fastapi import APIRouter
from ..db import prisma
from ..schemas import MaintenanceCreate, MaintenanceUpdate
from ..serializers import maintenance_to_dict

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


def parse_date(s):
    if not s:
        return None
    return datetime.fromisoformat(s)


@router.get("")
async def list_maintenance(tenant_id: str):
    rows = await prisma.maintenancerequest.find_many(where={"tenantId": tenant_id}, order={"createdAt": "desc"})
    return [maintenance_to_dict(r) for r in rows]


@router.post("")
async def create_maintenance(tenant_id: str, body: MaintenanceCreate):
    row = await prisma.maintenancerequest.create(data={
        "tenantId": tenant_id, "assetId": body.assetId, "description": body.desc, "dueDate": parse_date(body.due),
    })
    return maintenance_to_dict(row)


@router.patch("/{request_id}")
async def update_maintenance(request_id: str, body: MaintenanceUpdate):
    row = await prisma.maintenancerequest.update(where={"id": request_id}, data={"status": body.status})
    return maintenance_to_dict(row)
