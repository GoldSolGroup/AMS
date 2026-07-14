from fastapi import APIRouter
from ..db import prisma
from ..schemas import TrainingUpdate
from ..serializers import training_to_dict

router = APIRouter(prefix="/training", tags=["training"])


@router.get("")
async def list_training(tenant_id: str):
    rows = await prisma.trainingrecord.find_many(where={"tenantId": tenant_id}, order={"createdAt": "asc"})
    return [training_to_dict(r) for r in rows]


@router.patch("/{record_id}")
async def update_training(record_id: str, body: TrainingUpdate):
    row = await prisma.trainingrecord.update(where={"id": record_id}, data={"status": body.status, "signedOff": body.status == "Completed"})
    return training_to_dict(row)
