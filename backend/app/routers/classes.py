from fastapi import APIRouter
from ..db import prisma
from ..schemas import ClassCreate, ClassUpdate
from ..serializers import class_to_dict

router = APIRouter(prefix="/classes", tags=["classes"])


@router.get("")
async def list_classes(tenant_id: str):
    rows = await prisma.assetclass.find_many(where={"tenantId": tenant_id}, order={"name": "asc"})
    return [class_to_dict(r) for r in rows]


@router.post("")
async def create_class(tenant_id: str, body: ClassCreate):
    row = await prisma.assetclass.create(data={"tenantId": tenant_id, "name": body.name, "type": body.type, "usefulLifeYears": body.usefulLifeYears})
    return class_to_dict(row)


@router.patch("/{class_id}")
async def update_class(class_id: str, body: ClassUpdate):
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    row = await prisma.assetclass.update(where={"id": class_id}, data=data)
    return class_to_dict(row)
