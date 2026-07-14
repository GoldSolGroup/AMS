import re
from fastapi import APIRouter, Depends, HTTPException
from ..db import prisma
from ..schemas import TeamUpdate, PasswordPolicyUpdate, CreateUserIn
from ..serializers import team_to_dict, password_policy_to_dict, login_audit_to_dict
from ..auth import require_admin, require_auth, hash_password, user_mission_scope, TOP_ROLES

router = APIRouter(tags=["security"])

MISSION_INCLUDE = {"mission": True}
NO_LOGIN_ROLES = {"Custodian"}  # the only employee-record-only role — no system access


@router.get("/team")
async def list_team(tenant_id: str, user=Depends(require_auth)):
    where = {"tenantId": tenant_id}
    scope = user_mission_scope(user)
    if scope is not None:
        if scope == "__NONE__":
            return []
        where["mission"] = {"name": scope}
    rows = await prisma.teammember.find_many(where=where, order={"fullName": "asc"}, include=MISSION_INCLUDE)
    return [team_to_dict(r) for r in rows]


async def _validate_password(tenant_id: str, password: str):
    policy = await prisma.passwordpolicy.find_unique(where={"tenantId": tenant_id})
    min_len = policy.minLength if policy else 12
    complexity = policy.complexity if policy else True
    if len(password) < min_len:
        raise HTTPException(status_code=400, detail=f"Password must be at least {min_len} characters (per Password Policy).")
    if complexity and not (re.search(r"[A-Z]", password) and re.search(r"[a-z]", password) and re.search(r"\d", password)):
        raise HTTPException(status_code=400, detail="Password must include an uppercase letter, a lowercase letter, and a number (per Password Policy).")


@router.post("/team")
async def create_user(tenant_id: str, body: CreateUserIn, user=Depends(require_auth)):
    if user.role == "System Owner":
        mission_id = body.missionId
        if body.role not in TOP_ROLES and not mission_id:
            raise HTTPException(status_code=400, detail=f"{body.role} requires a mission to be assigned")
    elif user.role == "Mission Admin":
        if body.role != "Custodian":
            raise HTTPException(status_code=403, detail="Mission Admins can only create Custodians within their own mission")
        mission_id = user.missionId
    else:
        raise HTTPException(status_code=403, detail="Only a System Owner or Mission Admin can create users")

    is_custodian = body.role in NO_LOGIN_ROLES
    if not is_custodian:
        if not body.email or not body.password:
            raise HTTPException(status_code=400, detail=f"{body.role} needs a login — email and password are required.")
        await _validate_password(tenant_id, body.password)
        existing = await prisma.teammember.find_first(where={"tenantId": tenant_id, "email": body.email})
        if existing is not None:
            raise HTTPException(status_code=409, detail="A user with that email already exists")

    row = await prisma.teammember.create(data={
        "tenantId": tenant_id, "fullName": body.fullName,
        "email": body.email if not is_custodian else None,
        "passwordHash": hash_password(body.password) if (not is_custodian and body.password) else None,
        "role": body.role, "missionId": mission_id,
        "status": "Pending Vetting" if not is_custodian else "Active",
        "vetted": is_custodian,
    }, include=MISSION_INCLUDE)
    return team_to_dict(row)


async def _check_mission_authority(user, target_id, delete_mode=False):
    """Mission Admins may only manage users within their own mission — and
    may only DELETE custodian records (per the meeting notes), not other
    accounts. System Owner / Head Office Admin can manage/delete anyone."""
    if user.role in TOP_ROLES:
        return
    if user.role != "Mission Admin":
        raise HTTPException(status_code=403, detail="Administrator or Mission Admin access required")
    target = await prisma.teammember.find_unique(where={"id": target_id})
    if target is None or target.missionId != user.missionId:
        raise HTTPException(status_code=403, detail="You can only manage users within your own mission")
    if delete_mode and target.role not in NO_LOGIN_ROLES:
        raise HTTPException(status_code=403, detail="Mission Admins can only remove custodians")


@router.patch("/team/{member_id}")
async def update_team(member_id: str, body: TeamUpdate, user=Depends(require_auth)):
    await _check_mission_authority(user, member_id)
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    row = await prisma.teammember.update(where={"id": member_id}, data=data, include=MISSION_INCLUDE)
    return team_to_dict(row)


@router.delete("/team/{member_id}")
async def delete_team_member(member_id: str, user=Depends(require_auth)):
    await _check_mission_authority(user, member_id, delete_mode=True)
    await prisma.teammember.delete(where={"id": member_id})
    return {"ok": True}


@router.post("/team/{member_id}/confirm-vetting")
async def confirm_vetting(member_id: str, user=Depends(require_auth)):
    await _check_mission_authority(user, member_id)
    row = await prisma.teammember.update(where={"id": member_id}, data={"vetted": True, "status": "Active"}, include=MISSION_INCLUDE)
    return team_to_dict(row)


@router.get("/password-policy")
async def get_password_policy(tenant_id: str):
    row = await prisma.passwordpolicy.find_unique(where={"tenantId": tenant_id})
    return password_policy_to_dict(row)


@router.put("/password-policy")
async def update_password_policy(tenant_id: str, body: PasswordPolicyUpdate, admin=Depends(require_admin)):
    row = await prisma.passwordpolicy.upsert(
        where={"tenantId": tenant_id},
        data={
            "create": {"tenantId": tenant_id, "minLength": body.minLength, "complexity": body.complexity, "expiryDays": body.expiryDays, "historyCount": body.historyCount},
            "update": {"minLength": body.minLength, "complexity": body.complexity, "expiryDays": body.expiryDays, "historyCount": body.historyCount},
        },
    )
    return password_policy_to_dict(row)


@router.get("/login-audit")
async def list_login_audit(tenant_id: str, user=Depends(require_auth)):
    where = {"tenantId": tenant_id}
    if user.role not in TOP_ROLES:
        where["userName"] = user.fullName  # non-top roles only see their own login history
    rows = await prisma.loginaudit.find_many(where=where, order={"createdAt": "desc"})
    return [login_audit_to_dict(r) for r in rows]
