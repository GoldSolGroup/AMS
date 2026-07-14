"""
Populates the database with a default tenant and realistic starter data.

Run after `prisma generate` and `prisma db push`:
    python seed.py
"""
import asyncio
from datetime import datetime

from prisma import Prisma
from app.auth import hash_password


async def main():
    db = Prisma()
    await db.connect()

    tenant = await db.tenant.find_first(where={"orgName": "DIRCO"})
    if tenant is None:
        tenant = await db.tenant.create(data={"orgName": "DIRCO"})
    tid = tenant.id
    print(f"Using tenant {tid}")

    # --- Asset classes -------------------------------------------------
    classes = [
        ("ICT Equipment", "Movable"), ("Office Furniture", "Movable"), ("Vehicles", "Movable"),
        ("Building Improvements", "Immovable"), ("Machinery & Equipment", "Movable"), ("Specialised Equipment", "Movable"),
    ]
    for name, type_ in classes:
        existing = await db.assetclass.find_first(where={"tenantId": tid, "name": name})
        if not existing:
            await db.assetclass.create(data={"tenantId": tid, "name": name, "type": type_, "predefined": True, "active": True})

    # --- Assets ----------------------------------------------------------
    assets = [
        dict(barcode="DIRCO-0010231", description="Dell Latitude 5440 Laptop", category="ICT Equipment",
             location="Head Office (OR Tambo Bld)", room="3rd Floor, Rm 312", custodian="T. Mokoena",
             purchaseDate=datetime(2023, 4, 11), price=24500, status="In Use", costCentre="CC-1002", serial="SN-88213X"),
        dict(barcode="DIRCO-0010232", description="Executive Desk — Oak", category="Office Furniture",
             location="Mission: London", room="Chancery Office 2", custodian="N. Dlamini",
             purchaseDate=datetime(2021, 8, 2), price=8600, status="In Use", costCentre="CC-2044", serial="SN-11982"),
        dict(barcode="DIRCO-0010233", description="Toyota Land Cruiser 200", category="Vehicles",
             location="Mission: Nairobi", room="Motor Pool", custodian="R. Naidoo",
             purchaseDate=datetime(2019, 1, 20), price=985000, status="In Use", costCentre="CC-3001", serial="VIN-KE29817"),
        dict(barcode="DIRCO-0010234", description="HP LaserJet Enterprise M609", category="ICT Equipment",
             location="Mission: Beijing", room="Print Room", custodian="L. Chen (Local)",
             purchaseDate=datetime(2022, 11, 14), price=15200, status="In Use", costCentre="CC-1006", serial="SN-77234B"),
        dict(barcode="DIRCO-0010235", description="Generator — Standby 60kVA", category="Machinery & Equipment",
             location="Mission: Ottawa", room="Basement Plant Room", custodian="K. Adams",
             purchaseDate=datetime(2018, 6, 30), price=342000, status="In Use", costCentre="CC-4010", serial="SN-GEN0091"),
        dict(barcode="DIRCO-0010236", description="Conference Room AV System", category="Specialised Equipment",
             location="Head Office (OR Tambo Bld)", room="2nd Floor Boardroom", custodian="P. van Wyk",
             purchaseDate=datetime(2023, 9, 5), price=187500, status="In Use", costCentre="CC-1002", serial="SN-AV5521"),
        dict(barcode="DIRCO-0010237", description="Reception Furniture Suite", category="Office Furniture",
             location="Mission: Canberra", room="Reception", custodian="S. Ahmed",
             purchaseDate=datetime(2020, 2, 18), price=34200, status="Missing", costCentre="CC-5003", serial="SN-RF3390"),
        dict(barcode="DIRCO-0010238", description="Building Access Control Upgrade", category="Building Improvements",
             location="Head Office (OR Tambo Bld)", room="All Floors", custodian="ICT Directorate",
             purchaseDate=datetime(2024, 3, 1), price=512000, status="In Use", costCentre="CC-1090", serial="N/A"),
        dict(barcode="DIRCO-0010239", description="Projector — Epson EB-2250U", category="ICT Equipment",
             location="Head Office (OR Tambo Bld)", room="Training Room", custodian="T. Mokoena",
             purchaseDate=datetime(2021, 5, 19), price=0, status="In Use", costCentre="CC-1002", serial="SN-PRJ004"),
    ]
    asset_ids = {}
    for a in assets:
        existing = await db.asset.find_first(where={"tenantId": tid, "barcode": a["barcode"]})
        if existing:
            asset_ids[a["barcode"]] = existing.id
            continue
        row = await db.asset.create(data={
            **a, "tenantId": tid, "currency": "ZAR", "fundingSource": "Voted Funds",
            "scoaFund": "Vote 06", "scoaFunction": "International Relations", "scoaItem": a["category"],
        })
        asset_ids[a["barcode"]] = row.id
    print(f"Seeded {len(asset_ids)} assets")

    # --- WIP projects ------------------------------------------------------
    wip_defs = [
        dict(name="Pretoria HQ — Access Control Upgrade", location="Head Office (OR Tambo Bld)", budget=1250000, status="In Progress",
             invoices=[("INV-2201", 420000), ("INV-2244", 392000)],
             retentions=[(10, "Absa Guarantee #A1123")], cessions=[],
             boq=[("Access control panels x12", 260000), ("Cabling & install labour", 180000)]),
        dict(name="Nairobi Mission — Chancery Refurbishment", location="Mission: Nairobi", budget=3400000, status="Ready to Capitalise",
             invoices=[("INV-3010", 3400000)], retentions=[(5, "Standard Bank Guarantee #S9981")],
             cessions=[("BuildCo Kenya Ltd", 850000)],
             boq=[("Structural refurbishment", 2100000), ("Interiors & finishes", 1300000)]),
        dict(name="Ottawa Mission — Server Room Fit-out", location="Mission: Ottawa", budget=640000, status="In Progress",
             invoices=[("INV-4402", 210000)], retentions=[], cessions=[], boq=[("Cooling & racks", 210000)]),
    ]
    for w in wip_defs:
        existing = await db.wipproject.find_first(where={"tenantId": tid, "name": w["name"]})
        if existing:
            if existing.location != w["location"]:
                await db.wipproject.update(where={"id": existing.id}, data={"location": w["location"]})
            continue
        project = await db.wipproject.create(data={"tenantId": tid, "name": w["name"], "location": w["location"], "budget": w["budget"], "status": w["status"]})
        for ref, amount in w["invoices"]:
            await db.wipinvoice.create(data={"projectId": project.id, "ref": ref, "amount": amount})
        for pct, surety in w["retentions"]:
            await db.wipretention.create(data={"projectId": project.id, "pct": pct, "surety": surety})
        for beneficiary, amount in w["cessions"]:
            await db.wipcession.create(data={"projectId": project.id, "beneficiary": beneficiary, "amount": amount})
        for item, amount in w["boq"]:
            await db.wipboq.create(data={"projectId": project.id, "item": item, "amount": amount})
    print("Seeded WIP projects")

    # --- Verification cycles ------------------------------------------------
    for scope in ["Head Office (OR Tambo Bld)", "Mission: London"]:
        existing = await db.verificationcycle.find_first(where={"tenantId": tid, "scope": scope, "closed": False})
        if existing:
            continue
        cycle = await db.verificationcycle.create(data={"tenantId": tid, "scope": scope, "dueDate": datetime(2026, 7, 31)})
        matching = await db.asset.find_many(where={"tenantId": tid, "location": scope, "NOT": {"status": "Disposed"}})
        for a in matching:
            await db.verificationcycleasset.create(data={"cycleId": cycle.id, "assetId": a.id})
    print("Seeded verification cycles")

    # --- Maintenance ---------------------------------------------------------
    maint = [
        ("DIRCO-0010233", "500km service & brake inspection", datetime(2026, 7, 20), "Scheduled"),
        ("DIRCO-0010235", "Annual generator load test", datetime(2026, 8, 1), "Requested"),
    ]
    for barcode, desc, due, status in maint:
        if barcode not in asset_ids:
            continue
        existing = await db.maintenancerequest.find_first(where={"assetId": asset_ids[barcode], "description": desc})
        if not existing:
            await db.maintenancerequest.create(data={"tenantId": tid, "assetId": asset_ids[barcode], "description": desc, "dueDate": due, "status": status})

    # --- Training --------------------------------------------------------
    training = [
        ("System Configuration & Admin", "ICT Directorate", "N. Dlamini", "Completed", True),
        ("Troubleshooting & Support", "ICT Directorate", "N. Dlamini", "Completed", True),
        ("Asset Registration & Verification", "Asset Management", "T. Mokoena", "Scheduled", False),
        ("Disposals & WIP Capitalisation", "Finance/SCM", "P. van Wyk", "Not Started", False),
        ("Reporting & Reconciliation", "Finance/SCM", "—", "Not Started", False),
    ]
    for module, audience, trainee, status, signed in training:
        existing = await db.trainingrecord.find_first(where={"tenantId": tid, "module": module})
        if not existing:
            await db.trainingrecord.create(data={"tenantId": tid, "module": module, "audience": audience, "trainee": trainee, "status": status, "signedOff": signed})

    # --- Support tickets -------------------------------------------------
    tickets = [
        ("Barcode scanner not pairing — Nairobi", "High", "4h", "In Progress"),
        ("GL export failed for June batch", "Medium", "24h", "Open"),
        ("New user account — Ottawa custodian", "Low", "72h", "Resolved"),
    ]
    for subject, priority, sla, status in tickets:
        existing = await db.supportticket.find_first(where={"tenantId": tid, "subject": subject})
        if not existing:
            await db.supportticket.create(data={"tenantId": tid, "subject": subject, "priority": priority, "sla": sla, "status": status})

    # --- Milestones --------------------------------------------------------
    milestones = [
        ("System Configuration", datetime(2026, 7, 15), "Complete"),
        ("Legacy Data Migration", datetime(2026, 8, 5), "In Progress"),
        ("Skills Transfer & Training", datetime(2026, 8, 20), "Not Started"),
        ("User Acceptance Testing", datetime(2026, 9, 1), "Not Started"),
        ("Go-Live — Head Office & Missions", datetime(2026, 9, 15), "Not Started"),
    ]
    for name, date, status in milestones:
        existing = await db.milestone.find_first(where={"tenantId": tid, "name": name})
        if not existing:
            await db.milestone.create(data={"tenantId": tid, "name": name, "targetDate": date, "status": status})

    # --- GL mapping --------------------------------------------------------
    gl = [
        ("ICT Equipment", "GL-1000"), ("Office Furniture", "GL-1010"), ("Vehicles", "GL-1020"),
        ("Building Improvements", "GL-1030"), ("Machinery & Equipment", "GL-1040"), ("Specialised Equipment", "GL-1050"),
    ]
    for category, code in gl:
        existing = await db.glmapping.find_first(where={"tenantId": tid, "category": category})
        if not existing:
            await db.glmapping.create(data={"tenantId": tid, "category": category, "glCode": code})

    # --- Password policy -----------------------------------------------------
    existing_pw = await db.passwordpolicy.find_unique(where={"tenantId": tid})
    if not existing_pw:
        await db.passwordpolicy.create(data={"tenantId": tid, "minLength": 12, "complexity": True, "expiryDays": 90, "historyCount": 5})

    # --- Login audit -------------------------------------------------------
    logins = [
        ("T. Mokoena", "Success", "10.12.4.21"),
        ("unknown", "Failed", "41.2.18.90"),
        ("P. van Wyk", "Failed", "102.65.10.4"),
    ]
    for user, outcome, ip in logins:
        existing = await db.loginaudit.find_first(where={"tenantId": tid, "userName": user, "ip": ip})
        if not existing:
            await db.loginaudit.create(data={"tenantId": tid, "userName": user, "outcome": outcome, "ip": ip})

    # --- Team roster -------------------------------------------------------
    team = [
        ("T. Mokoena", "Custodian", "Active", True, "2 hours ago"),
        ("N. Dlamini", "Mission Admin", "Active", True, "Yesterday"),
        ("R. Naidoo", "Custodian", "Active", True, "3 days ago"),
        ("P. van Wyk", "Custodian", "Suspended", True, "21 days ago"),
        ("M. Sithole", "Custodian", "Pending Vetting", False, "Never"),
    ]
    for name, role, status, vetted, last in team:
        existing = await db.teammember.find_first(where={"tenantId": tid, "fullName": name})
        if not existing:
            await db.teammember.create(data={"tenantId": tid, "fullName": name, "role": role, "status": status, "vetted": vetted, "lastLogin": last})

    # --- Normalise any old-style role strings to the simplified 4-tier system
    # (System Owner -> Head Office Admin -> Mission Admin -> Custodian) -----
    role_fixups = {
        "ICT Administrator": "Head Office Admin",
        "Asset Management Officer": "Custodian",
        "Finance/SCM Officer": "Custodian",
        "Verification Officer": "Custodian",
        "Mission Custodian": "Custodian",
        "Mission Custodian — Nairobi": "Custodian",
    }
    for old_role, new_role in role_fixups.items():
        stale = await db.teammember.find_many(where={"tenantId": tid, "role": old_role})
        for member in stale:
            await db.teammember.update(where={"id": member.id}, data={"role": new_role})
        if stale:
            print(f"Normalised {len(stale)} user(s) from role '{old_role}' -> '{new_role}'")

    # --- Real admin account (can actually log in) ---------------------------
    admin_email = "mashaudb@gmail.com"
    existing_admin = await db.teammember.find_first(where={"tenantId": tid, "email": admin_email})
    if not existing_admin:
        await db.teammember.create(data={
            "tenantId": tid, "fullName": "System Administrator", "email": admin_email,
            "passwordHash": hash_password("password1"), "role": "System Owner",
            "status": "Active", "vetted": True,
        })
        print(f"Created admin account: {admin_email} / password1 — change this password after first login.")
    else:
        print(f"Admin account {admin_email} already exists — skipped.")

    # --- Activity log --------------------------------------------------------
    existing_activity = await db.activitylog.find_first(where={"tenantId": tid})
    if not existing_activity:
        await db.activitylog.create(data={"tenantId": tid, "message": "System initialised with seed FAR data."})

    # --- Missions (replaces the old hardcoded location list) ---------------
    mission_defs = [
        ("Head Office (OR Tambo Bld)", None, True),
        ("Mission: London", "Europe", False),
        ("Mission: Nairobi", "Africa", False),
        ("Mission: Beijing", "Asia", False),
        ("Mission: Ottawa", "Americas", False),
        ("Mission: Canberra", "Oceania", False),
    ]
    for name, region, is_ho in mission_defs:
        existing = await db.mission.find_first(where={"tenantId": tid, "name": name})
        if not existing:
            await db.mission.create(data={"tenantId": tid, "name": name, "region": region, "isHeadOffice": is_ho})
        elif existing.region != region or existing.isHeadOffice != is_ho:
            await db.mission.update(where={"id": existing.id}, data={"region": region, "isHeadOffice": is_ho})
    print(f"Seeded {len(mission_defs)} missions with regions")

    print("Seed complete.")
    await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
