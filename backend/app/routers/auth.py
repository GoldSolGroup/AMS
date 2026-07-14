from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Header, Request
from ..db import prisma
from ..schemas import LoginIn
from ..serializers import team_to_dict
from ..auth import verify_password, create_session, get_session_user

router = APIRouter(prefix="/auth", tags=["auth"])


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/login")
async def login(body: LoginIn, request: Request):
    ip = client_ip(request)
    user = await prisma.teammember.find_first(where={"email": body.email}, include={"mission": True})

    if user is None or not user.passwordHash or not verify_password(body.password, user.passwordHash):
        fallback_tenant = user.tenantId if user else (await prisma.tenant.find_first()).id
        await prisma.loginaudit.create(data={
            "tenantId": fallback_tenant,
            "userName": body.email, "outcome": "Failed", "ip": ip,
        })
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user.status != "Active":
        await prisma.loginaudit.create(data={"tenantId": user.tenantId, "userName": body.email, "outcome": "Failed", "ip": ip})
        raise HTTPException(status_code=403, detail=f"Account is {user.status.lower()} — contact your administrator")

    token = await create_session(user.id)
    now = datetime.now(timezone.utc)
    updated = await prisma.teammember.update(
        where={"id": user.id},
        data={"lastLoginAt": now, "lastLogin": "Just now"},
        include={"mission": True},
    )
    await prisma.loginaudit.create(data={"tenantId": user.tenantId, "userName": user.fullName, "outcome": "Success", "ip": ip})

    return {"token": token, "user": team_to_dict(updated)}


@router.post("/logout")
async def logout(authorization: str = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        session = await prisma.session.find_unique(where={"token": token})
        if session:
            await prisma.session.delete(where={"id": session.id})
    return {"ok": True}


@router.get("/me")
async def me(authorization: str = Header(None)):
    user = await get_session_user(authorization)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return team_to_dict(user)
