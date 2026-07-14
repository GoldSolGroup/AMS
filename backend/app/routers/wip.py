from datetime import datetime
from fastapi import APIRouter, Depends
from ..db import prisma
from ..schemas import InvoiceCreate, RetentionCreate, CessionCreate, BoqCreate, CapitaliseIn
from ..serializers import wip_to_dict, asset_to_dict
from ..auth import require_auth, user_mission_scope
from .assets import ASSET_INCLUDE
import random
import string

router = APIRouter(prefix="/wip", tags=["wip"])

WIP_INCLUDE = {"invoices": True, "retentions": True, "cessions": True, "boq": True}


def gen_barcode():
    return "DIRCO-" + "".join(random.choices(string.digits, k=6))


@router.get("")
async def list_wip(tenant_id: str, user=Depends(require_auth)):
    where = {"tenantId": tenant_id}
    scope = user_mission_scope(user)
    if scope is not None:
        if scope == "__NONE__":
            return []
        where["location"] = scope
    rows = await prisma.wipproject.find_many(where=where, include=WIP_INCLUDE, order={"createdAt": "asc"})
    return [wip_to_dict(r) for r in rows]


@router.post("/{project_id}/invoices")
async def add_invoice(project_id: str, body: InvoiceCreate):
    await prisma.wipinvoice.create(data={"projectId": project_id, "ref": body.ref, "amount": body.amount})
    row = await prisma.wipproject.find_unique(where={"id": project_id}, include=WIP_INCLUDE)
    return wip_to_dict(row)


@router.post("/{project_id}/retentions")
async def add_retention(project_id: str, body: RetentionCreate):
    await prisma.wipretention.create(data={"projectId": project_id, "pct": body.pct, "surety": body.surety})
    row = await prisma.wipproject.find_unique(where={"id": project_id}, include=WIP_INCLUDE)
    return wip_to_dict(row)


@router.post("/{project_id}/cessions")
async def add_cession(project_id: str, body: CessionCreate):
    await prisma.wipcession.create(data={"projectId": project_id, "beneficiary": body.beneficiary, "amount": body.amount})
    row = await prisma.wipproject.find_unique(where={"id": project_id}, include=WIP_INCLUDE)
    return wip_to_dict(row)


@router.post("/{project_id}/boq")
async def add_boq(project_id: str, body: BoqCreate):
    await prisma.wipboq.create(data={"projectId": project_id, "item": body.item, "amount": body.amount})
    row = await prisma.wipproject.find_unique(where={"id": project_id}, include=WIP_INCLUDE)
    return wip_to_dict(row)


@router.post("/{project_id}/capitalise")
async def capitalise(project_id: str, tenant_id: str, body: CapitaliseIn):
    project = await prisma.wipproject.find_unique(where={"id": project_id})
    location = (project.location if project else None) or body.location
    created = []
    for line in body.lines:
        asset = await prisma.asset.create(
            data={
                "tenantId": tenant_id, "barcode": gen_barcode(), "description": line.desc,
                "category": "Building Improvements", "location": location, "custodian": "Asset Management",
                "purchaseDate": datetime.utcnow(), "price": line.value, "status": "In Use",
                "costCentre": "CC-CAP", "serial": "N/A", "wipProjectId": project_id,
                "fundingSource": "Voted Funds", "scoaFund": "Vote 06", "scoaFunction": "International Relations",
                "scoaItem": "Capital Assets" + (f" — {project.name}" if project else ""),
            },
            include=ASSET_INCLUDE,
        )
        created.append(asset)
    await prisma.wipproject.update(where={"id": project_id}, data={"status": "Capitalised"})
    return [asset_to_dict(a) for a in created]
