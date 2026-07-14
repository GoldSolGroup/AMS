from fastapi import APIRouter
from ..db import prisma
from ..schemas import CorrectionCreate
from ..serializers import correction_to_dict

router = APIRouter(prefix="/correction-journals", tags=["compliance"])


@router.get("")
async def list_corrections(tenant_id: str):
    rows = await prisma.correctionjournal.find_many(where={"tenantId": tenant_id}, order={"createdAt": "desc"})
    return [correction_to_dict(r) for r in rows]


@router.post("")
async def create_correction(tenant_id: str, body: CorrectionCreate):
    row = await prisma.correctionjournal.create(data={
        "tenantId": tenant_id, "assetId": body.assetId, "reason": body.reason,
        "evidence": body.evidence, "approver": body.approver,
    })
    return correction_to_dict(row)
