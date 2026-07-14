import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Header, HTTPException

from .db import prisma

SESSION_LIFETIME_HOURS = 24 * 7  # 7 days


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


async def create_session(team_member_id: str) -> str:
    token = secrets.token_urlsafe(32)
    await prisma.session.create(data={
        "token": token,
        "teamMemberId": team_member_id,
        "expiresAt": datetime.now(timezone.utc) + timedelta(hours=SESSION_LIFETIME_HOURS),
    })
    return token


async def get_session_user(authorization: str | None):
    """Resolves a Bearer token to its TeamMember, or None if missing/invalid/expired."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    session = await prisma.session.find_unique(where={"token": token}, include={"teamMember": {"include": {"mission": True}}})
    if session is None:
        return None
    if session.expiresAt < datetime.now(timezone.utc):
        await prisma.session.delete(where={"id": session.id})
        return None
    return session.teamMember


async def require_auth(authorization: str = Header(None)):
    user = await get_session_user(authorization)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.status != "Active":
        raise HTTPException(status_code=403, detail=f"Account is {user.status.lower()}")
    return user


ADMIN_ROLES = {"System Owner", "Head Office Admin"}
MISSION_ADMIN_ROLES = {"Mission Admin"}
TOP_ROLES = {"System Owner", "Head Office Admin"}  # see all missions' data


async def require_admin(authorization: str = Header(None)):
    user = await require_auth(authorization)
    if user.role not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


async def require_mission_or_admin(authorization: str = Header(None)):
    """For approving/managing within a mission: System Owner, Head Office
    Admin (all missions) or Mission Admin (their own mission only)."""
    user = await require_auth(authorization)
    if user.role not in ADMIN_ROLES | MISSION_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Administrator or Mission Admin access required")
    return user


def user_mission_scope(user):
    """Returns None if the user sees all missions' data, or their mission's
    name (string) if they're scoped to just one. A mission-scoped role with
    no mission assigned yet sees nothing (empty string sentinel)."""
    if user.role in TOP_ROLES:
        return None
    return user.mission.name if getattr(user, "mission", None) else "__NONE__"
