from fastapi import APIRouter
from ..db import prisma
from ..schemas import TicketCreate, TicketUpdate, MilestoneUpdate, GlUpdate, MigrationRunCreate
from ..serializers import ticket_to_dict, milestone_to_dict, gl_to_dict

router = APIRouter(tags=["sysadmin"])


@router.get("/tickets")
async def list_tickets(tenant_id: str):
    rows = await prisma.supportticket.find_many(where={"tenantId": tenant_id}, order={"createdAt": "desc"})
    return [ticket_to_dict(r) for r in rows]


@router.post("/tickets")
async def create_ticket(tenant_id: str, body: TicketCreate):
    row = await prisma.supportticket.create(data={"tenantId": tenant_id, "subject": body.subject, "priority": body.priority, "sla": body.sla})
    return ticket_to_dict(row)


@router.patch("/tickets/{ticket_id}")
async def update_ticket(ticket_id: str, body: TicketUpdate):
    row = await prisma.supportticket.update(where={"id": ticket_id}, data={"status": body.status})
    return ticket_to_dict(row)


@router.get("/milestones")
async def list_milestones(tenant_id: str):
    rows = await prisma.milestone.find_many(where={"tenantId": tenant_id}, order={"targetDate": "asc"})
    return [milestone_to_dict(r) for r in rows]


@router.patch("/milestones/{milestone_id}")
async def update_milestone(milestone_id: str, body: MilestoneUpdate):
    row = await prisma.milestone.update(where={"id": milestone_id}, data={"status": body.status})
    return milestone_to_dict(row)


@router.get("/gl-mapping")
async def list_gl_mapping(tenant_id: str):
    rows = await prisma.glmapping.find_many(where={"tenantId": tenant_id}, order={"category": "asc"})
    return [gl_to_dict(r) for r in rows]


@router.patch("/gl-mapping/{mapping_id}")
async def update_gl_mapping(mapping_id: str, body: GlUpdate):
    row = await prisma.glmapping.update(where={"id": mapping_id}, data={"glCode": body.glCode})
    return gl_to_dict(row)


@router.post("/migration-runs")
async def record_migration_run(tenant_id: str, body: MigrationRunCreate):
    row = await prisma.migrationrun.create(data={
        "tenantId": tenant_id, "legacyCount": body.legacyCount, "legacyValue": body.legacyValue,
        "migratedCount": body.migratedCount, "migratedValue": body.migratedValue,
    })
    return {"id": row.id, "status": row.status}
