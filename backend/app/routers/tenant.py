from fastapi import APIRouter, Depends
from ..db import prisma
from ..schemas import TenantUpdate
from ..serializers import tenant_to_dict
from ..auth import require_admin

router = APIRouter(prefix="/tenant", tags=["tenant"])


@router.get("")
async def get_or_create_tenant():
    tenant = await prisma.tenant.find_first()
    if tenant is None:
        tenant = await prisma.tenant.create(data={"orgName": "DIRCO"})
    return tenant_to_dict(tenant)


@router.patch("/{tenant_id}")
async def update_tenant(tenant_id: str, body: TenantUpdate, admin=Depends(require_admin)):
    provided = body.model_dump(exclude_unset=True)
    if "same_region_requires_approval" in provided and admin.role != "System Owner":
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Only the System Owner can change approval policy")
    field_map = {
        "org_name": "orgName", "logo_url": "logoUrl", "primary_color": "primaryColor",
        "accent_color": "accentColor", "secondary_color": "secondaryColor", "theme_name": "themeName",
        "same_region_requires_approval": "sameRegionRequiresApproval",
    }
    data = {field_map[k]: v for k, v in provided.items() if k in field_map}
    tenant = await prisma.tenant.update(where={"id": tenant_id}, data=data)
    return tenant_to_dict(tenant)
