from fastapi import APIRouter
from ..db import prisma
from ..schemas import ActivityCreate
from ..serializers import activity_to_dict

router = APIRouter(prefix="/activity", tags=["activity"])


@router.get("")
async def list_activity(tenant_id: str):
    rows = await prisma.activitylog.find_many(where={"tenantId": tenant_id}, order={"createdAt": "desc"}, take=50)
    return [activity_to_dict(r) for r in rows]


@router.post("")
async def create_activity(tenant_id: str, body: ActivityCreate):
    row = await prisma.activitylog.create(data={"tenantId": tenant_id, "message": body.message})
    return activity_to_dict(row)
