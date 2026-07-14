# DIRCO Electronic Asset Management System

A white-label-ready Electronic Asset Management System, built against the DIRCO
Terms of Reference. Stack:

- **Database:** Postgres (any provider — Supabase, Railway, RDS, or local)
- **Schema/ORM:** Prisma (`backend/prisma/schema.prisma` is the single source of truth)
- **Backend:** Python, FastAPI, served by the async `prisma-client-py` client
- **Frontend:** React + Vite, talking to the backend over plain REST/JSON

```
Frontend (React)  →  fetch()  →  FastAPI (Python)  →  Prisma  →  Postgres
```

## 1. Get a Postgres database

Any Postgres works. Easiest options:
- [Supabase](https://supabase.com) → New Project → copy the **connection string**
  from Project Settings → Database → Connection string (URI). Use the
  "Session" pooler string, or the direct connection string — either works
  for this app.
- Or run Postgres locally / use Railway, Neon, RDS, etc.

## 2. Set up the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `backend/.env` and set `DATABASE_URL` to your Postgres connection string.

Generate the Prisma client and create the tables:

```bash
prisma generate --schema=prisma/schema.prisma
prisma db push --schema=prisma/schema.prisma
```

> `prisma generate` downloads a small query-engine binary the first time —
> this needs normal internet access (it isn't blocked in a typical dev
> environment, just flag it if you're behind a restrictive firewall/proxy).

Load starter data:

```bash
python seed.py
```

Run the API:

```bash
uvicorn app.main:app --reload --port 8000
```

Visit `http://localhost:8000/health` to confirm it's up, or
`http://localhost:8000/docs` for the interactive Swagger UI covering every
endpoint.

## 3. Set up the frontend

In a second terminal, from the project root:

```bash
cp .env.example .env      # VITE_API_URL defaults to http://localhost:8000
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). The app fetches
everything from the backend on load; if the backend isn't reachable it shows
exactly what to check.

## 4. Build for production

```bash
npm run build
npm run preview
```

For the backend, run `uvicorn app.main:app` behind a process manager
(gunicorn+uvicorn workers, systemd, Docker, etc.) — `--reload` is dev-only.

## Project structure

```
├── backend/
│   ├── prisma/schema.prisma   # database schema — edit this, then re-run
│   │                            `prisma generate` + `prisma db push`
│   ├── app/
│   │   ├── main.py             # FastAPI app, CORS, router wiring
│   │   ├── db.py               # Prisma client connect/disconnect
│   │   ├── schemas.py          # Pydantic request bodies
│   │   ├── serializers.py      # Prisma rows → the exact JSON shape the UI expects
│   │   └── routers/            # one file per resource (assets, wip, verification, ...)
│   ├── seed.py                  # starter data
│   ├── requirements.txt
│   └── .env.example
├── src/
│   ├── lib/api.js               # every frontend read/write — thin fetch() wrapper
│   ├── main.jsx
│   └── App.jsx                  # all screens/components
├── .env.example                  # VITE_API_URL
├── package.json
└── vite.config.js
```

## What's wired end-to-end

Every entity from the DIRCO TOR backlog is a real Postgres table (via
Prisma) with a real FastAPI endpoint and a real screen: asset register (+
photos, documents, transfer/reclassification history, disposals),
depreciation & fair valuation, WIP projects (invoices, retentions, cessions,
BOQ, capitalisation into new assets), GRAP classification library, SCOA
segments & roll-up reporting, verification cycles & barcode-scan matching,
maintenance requests, correction journals, donated-asset capitalisation,
training/skills-transfer tracking, support tickets, project milestones, GL
account mapping, password policy, login audit, and a live activity feed.

## Honest limitations / next steps

- **Auth:** the Security & Access screen manages a `TeamMember` table, not
  real user accounts — there's no login screen yet. Adding real auth (e.g.
  FastAPI + OAuth2/JWT, or a hosted option) is the natural next step; once
  in place, protect the routers with a dependency that checks the token and
  scopes queries to the authenticated user's tenant.
- **No row-level authorization yet.** Every endpoint currently trusts the
  `tenant_id` query param it's given. Fine for local development; before
  exposing this anywhere multi-user, derive `tenant_id` from an authenticated
  session instead of accepting it from the client.
- **File uploads** (photos, logos) are stored as base64 data URLs in text
  columns for simplicity. For production, upload to S3/GCS/Supabase Storage
  and store the resulting URL instead.
- **Exports** (disclosure notes, evidence packs, reports) download as plain
  text, standing in for real PDF/Excel generation.
- The **mobile scanning app** is simulated via a text input in the
  Verification screen, not an actual iOS/Android build.
- **Multi-tenancy** is modeled (every table has `tenantId`) but the app only
  ever loads/creates a single default tenant. A tenant switcher is
  straightforward to add since every query already filters by `tenant_id`.
