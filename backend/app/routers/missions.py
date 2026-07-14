from fastapi import APIRouter, Depends, HTTPException
from ..db import prisma
from ..schemas import MissionCreate, MissionUpdate
from ..serializers import mission_to_dict
from ..auth import require_auth

router = APIRouter(prefix="/missions", tags=["missions"])


@router.get("")
async def list_missions(tenant_id: str):
    rows = await prisma.mission.find_many(where={"tenantId": tenant_id}, order={"name": "asc"})
    return [mission_to_dict(r) for r in rows]


@router.post("")
async def create_mission(tenant_id: str, body: MissionCreate, user=Depends(require_auth)):
    if user.role != "System Owner":
        raise HTTPException(status_code=403, detail="Only the System Owner can define missions")
    existing = await prisma.mission.find_first(where={"tenantId": tenant_id, "name": body.name})
    if existing is not None:
        raise HTTPException(status_code=409, detail="A mission with that name already exists")
    row = await prisma.mission.create(data={"tenantId": tenant_id, "name": body.name, "region": body.region})
    return mission_to_dict(row)


@router.patch("/{mission_id}")
async def update_mission(mission_id: str, body: MissionUpdate, user=Depends(require_auth)):
    if user.role != "System Owner":
        raise HTTPException(status_code=403, detail="Only the System Owner can edit missions")
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    row = await prisma.mission.update(where={"id": mission_id}, data=data)
    return mission_to_dict(row)
