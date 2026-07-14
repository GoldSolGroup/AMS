from decimal import Decimal
from datetime import datetime


def _num(v):
    if v is None:
        return 0
    if isinstance(v, Decimal):
        return float(v)
    return v


def _date(v):
    if v is None:
        return ""
    try:
        return v.date().isoformat()
    except AttributeError:
        return v.isoformat()


def _ts(v):
    if v is None:
        return ""
    return v.strftime("%d %b %Y, %H:%M")


def _relative(dt):
    if dt is None:
        return "Never"
    now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
    delta = now - dt
    secs = delta.total_seconds()
    if secs < 60:
        return "Just now"
    if secs < 3600:
        m = int(secs // 60)
        return f"{m} minute{'s' if m != 1 else ''} ago"
    if secs < 86400:
        h = int(secs // 3600)
        return f"{h} hour{'s' if h != 1 else ''} ago"
    d = int(secs // 86400)
    return f"{d} day{'s' if d != 1 else ''} ago"


def tenant_to_dict(t):
    """Kept snake_case on purpose — the frontend reads tenant fields directly
    (org_name, logo_url, primary_color, ...) without a mapping layer."""
    return {
        "id": t.id,
        "org_name": t.orgName,
        "logo_url": t.logoUrl,
        "primary_color": t.primaryColor,
        "accent_color": t.accentColor,
        "secondary_color": t.secondaryColor,
        "theme_name": t.themeName,
        "same_region_requires_approval": t.sameRegionRequiresApproval,
    }


def class_to_dict(c):
    return {"id": c.id, "name": c.name, "type": c.type, "predefined": c.predefined, "active": c.active, "usefulLifeYears": c.usefulLifeYears}


def mission_to_dict(m):
    return {"id": m.id, "name": m.name, "region": m.region or "", "isHeadOffice": m.isHeadOffice}


def asset_to_list_dict(a):
    """Lightweight variant for bulk listing — deliberately excludes photos
    (stored as full base64 data URIs, which made the whole-register load
    very slow), documents, and history. Used for the Register/Dashboard;
    the full asset_to_dict is used when opening a single asset's detail."""
    disposals = sorted(a.disposals or [], key=lambda d: d.createdAt, reverse=True)
    disposal = disposals[0] if disposals else None
    return {
        "id": a.id,
        "barcode": a.barcode,
        "desc": a.description,
        "category": a.category,
        "location": a.location or "",
        "room": a.room or "",
        "custodian": a.custodian or "",
        "purchaseDate": _date(a.purchaseDate),
        "price": _num(a.price),
        "currency": a.currency,
        "status": a.status,
        "costCentre": a.costCentre or "",
        "serial": a.serial or "",
        "poNumber": a.poNumber or "",
        "invoiceRef": a.invoiceRef or "",
        "fundingSource": a.fundingSource,
        "scoa": {"fund": a.scoaFund or "", "func": a.scoaFunction or "", "item": a.scoaItem or ""},
        "donated": a.donated,
        "photoCount": (a._count.photos if getattr(a, "_count", None) else 0),
        "documentCount": (a._count.documents if getattr(a, "_count", None) else 0),
        "disposal": None if disposal is None else {
            "id": disposal.id, "method": disposal.method, "reason": disposal.reason,
            "value": _num(disposal.value), "status": disposal.status,
            "date": _date(disposal.disposalDate), "reference": disposal.reference,
        },
    }


def asset_to_dict(a):
    photos = a.photos or []
    documents = a.documents or []
    history = a.history or []
    disposals = sorted(a.disposals or [], key=lambda d: d.createdAt, reverse=True)
    disposal = disposals[0] if disposals else None
    return {
        "id": a.id,
        "barcode": a.barcode,
        "desc": a.description,
        "category": a.category,
        "location": a.location or "",
        "room": a.room or "",
        "custodian": a.custodian or "",
        "purchaseDate": _date(a.purchaseDate),
        "price": _num(a.price),
        "currency": a.currency,
        "status": a.status,
        "costCentre": a.costCentre or "",
        "serial": a.serial or "",
        "poNumber": a.poNumber or "",
        "invoiceRef": a.invoiceRef or "",
        "fundingSource": a.fundingSource,
        "scoa": {"fund": a.scoaFund or "", "func": a.scoaFunction or "", "item": a.scoaItem or ""},
        "donated": a.donated,
        "photos": [p.url for p in photos],
        "documents": [{"id": d.id, "name": d.name, "ts": _ts(d.createdAt)} for d in documents],
        "history": [{"id": h.id, "type": h.type, "note": h.note, "actor": h.actor, "ts": _ts(h.createdAt)} for h in history],
        "disposal": None if disposal is None else {
            "id": disposal.id, "method": disposal.method, "reason": disposal.reason,
            "value": _num(disposal.value), "status": disposal.status,
            "date": _date(disposal.disposalDate), "reference": disposal.reference,
        },
    }


def wip_to_dict(p):
    return {
        "id": p.id, "name": p.name, "location": p.location or "", "budget": _num(p.budget), "status": p.status,
        "invoices": [{"id": i.id, "ref": i.ref, "amount": _num(i.amount)} for i in (p.invoices or [])],
        "retentions": [{"id": r.id, "pct": _num(r.pct), "surety": r.surety} for r in (p.retentions or [])],
        "cessions": [{"id": c.id, "beneficiary": c.beneficiary, "amount": _num(c.amount)} for c in (p.cessions or [])],
        "boq": [{"id": b.id, "item": b.item, "amount": _num(b.amount)} for b in (p.boq or [])],
    }


def cycle_to_dict(c):
    links = c.assets or []
    return {
        "id": c.id, "scope": c.scope, "due": _date(c.dueDate), "closed": c.closed,
        "assetIds": [l.assetId for l in links],
        "verifiedIds": [l.assetId for l in links if l.verified],
        "scanLog": [
            {"assetId": l.assetId, "verifiedBy": l.verifiedBy, "verifiedAt": _ts(l.verifiedAt)}
            for l in sorted([x for x in links if x.verified], key=lambda x: x.verifiedAt or x.id, reverse=True)
        ],
    }


def maintenance_to_dict(m):
    return {"id": m.id, "assetId": m.assetId, "desc": m.description, "due": _date(m.dueDate), "status": m.status}


def correction_to_dict(c):
    return {"id": c.id, "assetId": c.assetId, "reason": c.reason, "evidence": c.evidence, "approver": c.approver, "ts": _ts(c.createdAt)}


def training_to_dict(t):
    return {"id": t.id, "module": t.module, "audience": t.audience, "trainee": t.trainee, "status": t.status, "signedOff": t.signedOff}


def ticket_to_dict(t):
    return {"id": t.id, "subject": t.subject, "priority": t.priority, "due": t.sla, "status": t.status}


def milestone_to_dict(m):
    return {"id": m.id, "name": m.name, "date": _date(m.targetDate), "status": m.status}


def gl_to_dict(g):
    return {"id": g.id, "category": g.category, "glCode": g.glCode or ""}


def team_to_dict(u):
    return {
        "id": u.id, "name": u.fullName, "email": u.email or "", "role": u.role,
        "status": u.status, "vetted": u.vetted, "lastLogin": _relative(u.lastLoginAt) if u.lastLoginAt else (u.lastLogin or "Never"),
        "hasLogin": bool(u.email and u.passwordHash),
        "missionId": u.missionId, "missionName": (u.mission.name if getattr(u, "mission", None) else None),
    }


def password_policy_to_dict(p):
    if p is None:
        return {"minLength": 12, "complexity": True, "expiryDays": 90, "historyCount": 5}
    return {"minLength": p.minLength, "complexity": p.complexity, "expiryDays": p.expiryDays, "historyCount": p.historyCount}


def login_audit_to_dict(l):
    return {"id": l.id, "user": l.userName, "outcome": l.outcome, "ip": l.ip, "ts": _ts(l.createdAt)}


def activity_to_dict(a):
    return {"id": a.id, "msg": a.message, "ts": _ts(a.createdAt)}


def action_request_to_dict(r, asset=None):
    import json
    try:
        payload = json.loads(r.payload)
    except (ValueError, TypeError):
        payload = {}
    return {
        "id": r.id, "assetId": r.assetId, "assetDesc": asset.description if asset else None,
        "assetBarcode": asset.barcode if asset else None, "assetLocation": asset.location if asset else None,
        "type": r.type, "payload": payload,
        "reason": r.reason, "requestedBy": r.requestedBy, "status": r.status,
        "reviewedBy": r.reviewedBy, "reviewNote": r.reviewNote,
        "createdAt": _ts(r.createdAt), "reviewedAt": _ts(r.reviewedAt) if r.reviewedAt else None,
    }
