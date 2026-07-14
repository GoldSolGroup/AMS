import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from . import db
from .auth import require_auth
from .routers import (
    tenant, classes, assets, wip, verification, maintenance,
    compliance, training, sysadmin, security, activity, auth as auth_router, approvals, missions,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    yield
    await db.disconnect()


app = FastAPI(title="DIRCO Asset Management API", lifespan=lifespan)

origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Public: no login required. /tenant GET is public too (defined inside tenant.router)
# since the login screen needs the org logo/name before anyone's authenticated.
app.include_router(auth_router.router)
app.include_router(tenant.router)

# Everything else requires a valid session (Authorization: Bearer <token>).
protected = Depends(require_auth)
app.include_router(classes.router, dependencies=[protected])
app.include_router(assets.router, dependencies=[protected])
app.include_router(wip.router, dependencies=[protected])
app.include_router(verification.router, dependencies=[protected])
app.include_router(maintenance.router, dependencies=[protected])
app.include_router(compliance.router, dependencies=[protected])
app.include_router(training.router, dependencies=[protected])
app.include_router(sysadmin.router, dependencies=[protected])
app.include_router(security.router, dependencies=[protected])
app.include_router(activity.router, dependencies=[protected])
app.include_router(approvals.router, dependencies=[protected])
app.include_router(missions.router, dependencies=[protected])


@app.get("/health")
async def health():
    return {"status": "ok"}

