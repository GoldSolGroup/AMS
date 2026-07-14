import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import {
  LayoutGrid, Boxes, ScanBarcode, HardHat, ShieldCheck, Palette,
  Search, Plus, Upload, X, ChevronRight, MapPin, User, Calendar,
  TrendingDown, TrendingUp, CircleCheck, CircleAlert, CircleX,
  Building2, Wallet, ClipboardList, LogOut, Bell, Wrench, FileText,
  KeyRound, Database, Milestone, Ticket, GraduationCap, Landmark,
  Download, GitMerge, Layers, RefreshCw, CheckCircle2, AlertTriangle,
  Camera, Paperclip, ArrowRightLeft, Gift, FileSearch, ListChecks, Loader2, Info, PackageOpen, ClipboardCheck, Settings2, MoreVertical, Edit3
} from "lucide-react";
import {
  ResponsiveContainer, Tooltip, PieChart, Pie, Cell
} from "recharts";
import * as api from "./lib/api";

/* =====================================================================
   CONSTANTS (not DB-backed — configuration, not managed data)
===================================================================== */
// Missions are now a database-backed, admin-configurable list (see the Missions screen) —
const CATEGORIES = ["ICT Equipment", "Office Furniture", "Vehicles", "Building Improvements", "Machinery & Equipment", "Specialised Equipment"];
const USEFUL_LIFE = { "ICT Equipment": 3, "Office Furniture": 7, "Vehicles": 5, "Building Improvements": 20, "Machinery & Equipment": 10, "Specialised Equipment": 5 };
const FUNDING_SOURCES = ["Voted Funds", "Donor Funding", "Own Revenue", "Donation"];
const AS_OF = new Date("2026-07-02");
// No real authentication session exists yet (see README) — this stands in for
// "whoever is logged in" so actions like verification scans can still be attributed.
// (verification scans are now attributed to the real logged-in user via authUser.name)
const PRESETS = [
  { name: "Diplomatic Navy", primary: "#152A4E", accent: "#0E9C8F", secondary: "#C9A227" },
  { name: "Republic Green", primary: "#123524", accent: "#2E9E5B", secondary: "#D4A72C" },
  { name: "Slate & Coral", primary: "#1F2937", accent: "#EF6355", secondary: "#3B82F6" },
  { name: "Maroon Council", primary: "#3A1220", accent: "#B3542C", secondary: "#8FA6A3" },
];
const statusMeta = {
  "In Use": { color: "var(--ok)", icon: CircleCheck },
  "Available": { color: "var(--secondary)", icon: PackageOpen },
  "Under Verification": { color: "var(--warn)", icon: ClipboardList },
  "Disposed": { color: "var(--muted)", icon: CircleX },
  "Missing": { color: "var(--danger)", icon: CircleAlert },
  "Pending Disposal Approval": { color: "var(--warn)", icon: AlertTriangle },
};

function uid(prefix = "ID") { return prefix + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(); }
function fmtZAR(n) { return "R " + Math.round(n || 0).toLocaleString("en-ZA"); }
function initials(name) { return (name || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase(); }
function nowStamp() { return new Date().toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function yearsElapsed(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return Math.max(0, (AS_OF - d) / (1000 * 60 * 60 * 24 * 365.25));
}
function computeDepreciation(asset, classes) {
  const configured = classes?.find(c => c.name === asset.category)?.usefulLifeYears;
  const life = configured || USEFUL_LIFE[asset.category] || 5;
  const annual = asset.price / life;
  const yrs = yearsElapsed(asset.purchaseDate);
  const accumulated = Math.min(asset.price, annual * yrs);
  return { annual, accumulated, carrying: Math.max(0, asset.price - accumulated), life };
}

/* Control accounts used for the postings a per-asset GL mapping doesn't cover.
   These are placeholders — replace with DIRCO's actual GL account codes for
   payables, depreciation, accumulated depreciation, disposal proceeds and
   disposal profit/loss before using this in a real posting run. */
const GL_CONTROL_ACCOUNTS = {
  payables: "GL-2000-CREDITORS-CONTROL",
  deprExpense: "GL-5000-DEPRECIATION-EXPENSE",
  accDepr: "GL-1900-ACCUMULATED-DEPRECIATION",
  disposalProceeds: "GL-1200-DISPOSAL-PROCEEDS-RECEIVABLE",
  disposalPL: "GL-6000-PROFIT-LOSS-ON-DISPOSAL",
  unmapped: "GL-9999-UNMAPPED-SUSPENSE",
};

/* Builds a balanced double-entry journal batch (acquisitions, depreciation,
   disposals) for a period, using the GL account mapping the user configured.
   Returns rows plus the set of categories that had no mapped GL code, so the
   UI can warn before someone actually posts this. */
function buildGlJournal(assets, glMapping, periodStart, classes) {
  const glFor = (category) => glMapping.find(g => g.category === category)?.glCode || GL_CONTROL_ACCOUNTS.unmapped;
  const unmapped = new Set();
  const rows = [];
  const today = new Date().toISOString().slice(0, 10);
  const push = (date, ref, account, description, debit, credit) => rows.push({ date, ref, account, description, debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 });

  // 1) Acquisitions this period: Dr Asset (mapped GL account) / Cr Creditors Control
  assets.filter(a => a.purchaseDate && a.purchaseDate >= periodStart).forEach(a => {
    if (a.price <= 0) return;
    const account = glFor(a.category);
    if (account === GL_CONTROL_ACCOUNTS.unmapped) unmapped.add(a.category);
    const ref = a.poNumber || a.barcode;
    push(a.purchaseDate, ref, account, `Acquisition — ${a.desc} (${a.barcode})`, a.price, 0);
    push(a.purchaseDate, ref, GL_CONTROL_ACCOUNTS.payables, `Acquisition — ${a.desc} (${a.barcode})`, 0, a.price);
  });

  // 2) Depreciation, summarised by category (typical GL posting practice — not one line per asset)
  const deprByCategory = {};
  assets.filter(a => a.status !== "Disposed").forEach(a => {
    const dep = computeDepreciation(a, classes);
    if (dep.accumulated > 0) deprByCategory[a.category] = (deprByCategory[a.category] || 0) + dep.accumulated;
  });
  Object.entries(deprByCategory).forEach(([cat, amt]) => {
    const ref = "DEPR-" + cat.replace(/\s+/g, "").toUpperCase().slice(0, 12);
    push(today, ref, GL_CONTROL_ACCOUNTS.deprExpense, `Accumulated depreciation charge — ${cat}`, amt, 0);
    push(today, ref, GL_CONTROL_ACCOUNTS.accDepr, `Accumulated depreciation charge — ${cat}`, 0, amt);
  });

  // 3) Disposals this period: Dr Acc. Depreciation, Dr Disposal Proceeds, Cr Asset (at cost), balancing Dr/Cr Profit-or-Loss
  assets.filter(a => a.status === "Disposed" && a.disposal?.date && a.disposal.date >= periodStart).forEach(a => {
    const account = glFor(a.category);
    if (account === GL_CONTROL_ACCOUNTS.unmapped) unmapped.add(a.category);
    const dep = computeDepreciation(a, classes);
    const proceeds = a.disposal.value || 0;
    const ref = a.disposal.reference || a.barcode;
    const desc = `Disposal — ${a.desc} (${a.barcode})`;
    push(a.disposal.date, ref, account, desc, 0, a.price);
    if (dep.accumulated > 0) push(a.disposal.date, ref, GL_CONTROL_ACCOUNTS.accDepr, desc, dep.accumulated, 0);
    if (proceeds > 0) push(a.disposal.date, ref, GL_CONTROL_ACCOUNTS.disposalProceeds, desc, proceeds, 0);
    const plAmount = proceeds + dep.accumulated - a.price; // positive = gain (credit), negative = loss (debit)
    if (Math.abs(plAmount) > 0.01) {
      if (plAmount > 0) push(a.disposal.date, ref, GL_CONTROL_ACCOUNTS.disposalPL, `Gain on disposal — ${a.desc}`, 0, plAmount);
      else push(a.disposal.date, ref, GL_CONTROL_ACCOUNTS.disposalPL, `Loss on disposal — ${a.desc}`, -plAmount, 0);
    }
  });

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, totalDebit, totalCredit, unmapped: [...unmapped], balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

function glJournalToCsv(rows) {
  const header = "Date,Reference,GL Account,Description,Debit,Credit\n";
  const body = rows.map(r => [r.date, r.ref, r.account, `"${r.description.replace(/"/g, '""')}"`, r.debit.toFixed(2), r.credit.toFixed(2)].join(",")).join("\n");
  return header + body + "\n";
}

/* =====================================================================
   ROOT APP — bootstraps from Supabase, owns all state, all mutations
   go through src/lib/api.js and are persisted to Postgres.
===================================================================== */
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const fileRef = useRef(null);

  const [assets, setAssets] = useState([]);
  const [wip, setWip] = useState([]);
  const [classes, setClasses] = useState([]);
  const [missions, setMissions] = useState([]);
  const [team, setTeam] = useState([]);
  const [loginAudit, setLoginAudit] = useState([]);
  const [passwordPolicy, setPasswordPolicy] = useState({ minLength: 12, complexity: true, expiryDays: 90, historyCount: 5 });
  const [cycles, setCycles] = useState([]);
  const [correctionJournals, setCorrectionJournals] = useState([]);
  const [maintenance, setMaintenance] = useState([]);
  const [training, setTraining] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [glMapping, setGlMapping] = useState([]);
  const [migration, setMigration] = useState({ status: "idle", legacyCount: 812, legacyValue: 46200000 });
  const [activity, setActivity] = useState([]);
  const [actionRequests, setActionRequests] = useState([]);
  const [logsLastRefresh, setLogsLastRefresh] = useState(null);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [registerNav, setRegisterNav] = useState({ status: "All", key: 0 });
  function goToRegister(status) { setTab("register"); setRegisterNav(prev => ({ status, key: prev.key + 1 })); }

  const log = useCallback((msg) => {
    const actor = authUser?.name || "System";
    const full = `${actor} — ${msg}`;
    setActivity(prev => [{ id: uid("LOG"), msg: full, ts: nowStamp() }, ...prev].slice(0, 300));
    if (tenant) api.logActivity(tenant.id, full).catch(() => {});
  }, [tenant, authUser]);

  const logErr = useCallback((action, err) => {
    console.error(action, err);
    setActivity(prev => [{ id: uid("LOG"), msg: `⚠ ${action} failed: ${err.message || err}`, ts: nowStamp() }, ...prev].slice(0, 300));
  }, []);

  /* ---------------- Load every protected data set (called after login) ---------------- */
  async function loadProtectedData(tenantId) {
    const [
      assetsRows, wipRows, classRows, teamRows, auditRows, pwRow, cycleRows,
      correctionRows, maintRows, trainRows, ticketRows, msRows, glRows, activityRows, requestRows, missionRows,
    ] = await Promise.all([
      api.getAssetsFull(tenantId), api.getWipFull(tenantId), api.getClasses(tenantId), api.getTeam(tenantId),
      api.getLoginAudit(tenantId), api.getPasswordPolicy(tenantId), api.getCyclesFull(tenantId),
      api.getCorrectionJournals(tenantId), api.getMaintenance(tenantId), api.getTraining(tenantId),
      api.getTickets(tenantId), api.getMilestones(tenantId), api.getGlMapping(tenantId), api.getActivity(tenantId),
      api.getActionRequests(tenantId), api.getMissions(tenantId),
    ]);
    setAssets(assetsRows); setWip(wipRows); setClasses(classRows); setTeam(teamRows);
    setLoginAudit(auditRows); setPasswordPolicy(pwRow); setCycles(cycleRows);
    setCorrectionJournals(correctionRows); setMaintenance(maintRows); setTraining(trainRows);
    setTickets(ticketRows); setMilestones(msRows); setGlMapping(glRows); setActivity(activityRows);
    setActionRequests(requestRows); setMissions(missionRows);
    setLogsLastRefresh(new Date());
  }
  async function refreshLogsFn() {
    if (!tenant) return;
    setLogsRefreshing(true);
    try {
      const [activityRows, auditRows] = await Promise.all([api.getActivity(tenant.id), api.getLoginAudit(tenant.id)]);
      setActivity(activityRows); setLoginAudit(auditRows);
      setLogsLastRefresh(new Date());
    } catch (err) { logErr("Refresh logs", err); }
    setLogsRefreshing(false);
  }

  /* ---------------- Bootstrap: tenant is public (needed for the login screen's logo); everything else needs a session ---------------- */
  useEffect(() => {
    api.setUnauthorizedHandler(() => { setAuthUser(null); });
    (async () => {
      try {
        const t = await api.getOrCreateTenant();
        setTenant(t);
        if (api.getToken()) {
          try {
            const user = await api.me();
            setAuthUser(user);
            await loadProtectedData(t.id);
          } catch {
            api.setToken(null);
          }
        }
        setAuthChecked(true);
        setLoading(false);
      } catch (err) {
        console.error(err);
        setBootError(err);
        setLoading(false);
      }
    })();
  }, []);

  async function handleLoginSuccess(user) {
    setAuthUser(user);
    setLoading(true);
    try {
      await loadProtectedData(tenant.id);
    } catch (err) {
      setBootError(err);
    }
    setLoading(false);
  }

  async function handleLogout() {
    await api.logout();
    setAuthUser(null);
  }

  async function createUserFn(fullName, email, password, role, missionId) {
    try {
      const row = await api.createUser(tenant.id, fullName, email, password, role, missionId);
      setTeam(prev => [...prev, row].sort((a, b) => a.name.localeCompare(b.name)));
      log(`User account created: ${fullName}${email ? ` (${email})` : ""}.`);
      return { ok: true };
    } catch (err) { logErr("Create user", err); return { error: err.message }; }
  }
  async function deleteUserFn(id) {
    const target = team.find(u => u.id === id);
    try {
      await api.deleteTeamMember(id);
      setTeam(prev => prev.filter(u => u.id !== id));
      log(`Removed ${target?.name || id} from the roster.`);
      return { ok: true };
    } catch (err) { logErr("Remove user", err); return { error: err.message }; }
  }

  /* ---------------- Branding ---------------- */
  function setTheme(theme) {
    setTenant(prev => ({ ...prev, primary_color: theme.primary, accent_color: theme.accent, secondary_color: theme.secondary, theme_name: theme.name }));
    api.updateTenant(tenant.id, { primary_color: theme.primary, accent_color: theme.accent, secondary_color: theme.secondary }).catch(err => logErr("Update theme", err));
  }
  function setOrgName(name) {
    setTenant(prev => ({ ...prev, org_name: name }));
    api.updateTenant(tenant.id, { org_name: name }).catch(err => logErr("Update org name", err));
  }
  function handleLogoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setTenant(prev => ({ ...prev, logo_url: ev.target.result }));
      api.updateTenant(tenant.id, { logo_url: ev.target.result }).catch(err => logErr("Upload logo", err));
    };
    reader.readAsDataURL(file);
  }
  function removeLogo() {
    setTenant(prev => ({ ...prev, logo_url: null }));
    api.updateTenant(tenant.id, { logo_url: null }).catch(err => logErr("Remove logo", err));
  }

  /* ---------------- Assets ---------------- */
  async function addAsset(form) {
    try {
      const row = await api.addAsset(tenant.id, form);
      if (row?.__duplicate) return { duplicate: row.__duplicate };
      setAssets(prev => [row, ...prev]);
      log(`Asset captured: ${form.desc} (${form.barcode})`);
      return { ok: true };
    } catch (err) { logErr("Capture asset", err); return { error: err }; }
  }
  /* Transfer, Reclassification and Fair Valuation now require sign-off — this
     submits the request instead of applying it directly. */
  async function requestAssetActionFn(assetId, type, payload, reason) {
    try {
      await api.requestAssetAction(tenant.id, assetId, type, payload, reason);
      // Refetch (rather than optimistically splice in the raw response) so the
      // list always reflects the server's mission-scoping rules — e.g. a
      // Mission Admin requesting a cross-mission transfer should NOT see it
      // land in their own approval queue, since only Head Office can act on it.
      const rows = await api.getActionRequests(tenant.id);
      setActionRequests(rows);
      log(`${type} requested for asset ${assetId} — awaiting approval.`);
      return { ok: true };
    } catch (err) { logErr(`Request ${type}`, err); return { error: err.message }; }
  }
  async function editAssetFn(assetId, fields, note) {
    try {
      await api.addAssetHistory(assetId, "Edit", note || "Asset details updated", authUser?.name);
      const updated = await api.updateAsset(assetId, dbFieldsFromUi(fields));
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`Edited asset ${assetId}${note ? `: ${note}` : ""}.`);
      return { ok: true };
    } catch (err) { logErr("Edit asset", err); return { error: err.message }; }
  }
  /* The bulk asset list deliberately omits photos/documents/history (photos in
     particular are large base64 blobs) to keep the Register/Dashboard fast.
     This fetches the full record — only called when an asset is opened. */
  async function loadAssetDetailFn(assetId) {
    try {
      const full = await api.getAsset(assetId);
      setAssets(prev => prev.map(a => a.id === assetId ? full : a));
      return full;
    } catch (err) { logErr("Load asset detail", err); return null; }
  }
  async function approveActionRequestFn(id, note) {
    try {
      const res = await api.approveActionRequest(id, note);
      setActionRequests(prev => prev.map(r => r.id === id ? res.request : r));
      setAssets(prev => prev.map(a => a.id === res.asset.id ? res.asset : a));
      log(`Approved ${res.request.type} for ${res.request.assetDesc || res.request.assetId}.`);
      return { ok: true };
    } catch (err) { logErr("Approve request", err); return { error: err.message }; }
  }
  async function rejectActionRequestFn(id, note) {
    try {
      const res = await api.rejectActionRequest(id, note);
      setActionRequests(prev => prev.map(r => r.id === id ? res.request : r));
      log(`Rejected ${res.request.type} for ${res.request.assetDesc || res.request.assetId}.`);
      return { ok: true };
    } catch (err) { logErr("Reject request", err); return { error: err.message }; }
  }
  async function assetAction(assetId, action) {
    try {
      let updated = await api.addAssetHistory(assetId, action.type, action.note, authUser?.name);
      const fields = {};
      if (action.type === "Location/Custodian Transfer") {
        fields.location = action.newLocation; fields.custodian = action.newCustodian; fields.room = action.newRoom;
        const current = assets.find(a => a.id === assetId);
        if (current?.status === "Available" && action.newLocation) fields.status = "In Use";
      }
      if (action.type === "Reclassification") { fields.category = action.newCategory; }
      if (Object.keys(fields).length) updated = await api.updateAsset(assetId, dbFieldsFromUi(fields));
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`${action.type} recorded for ${assetId}: ${action.note}`);
    } catch (err) { logErr(action.type, err); }
  }
  async function addPhoto(assetId, dataUrl) {
    try {
      const updated = await api.addAssetPhoto(assetId, dataUrl);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
    } catch (err) { logErr("Add photo", err); }
  }
  async function addDocument(assetId, name) {
    try {
      const updated = await api.addAssetDocument(assetId, name);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`Document attached to ${assetId}: ${name}`);
    } catch (err) { logErr("Attach document", err); }
  }
  async function requestDisposal(assetId, data) {
    try {
      const updated = await api.requestDisposal(assetId, data);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`Disposal requested for ${assetId}: ${data.method}, reason: ${data.reason}`);
      return { ok: true };
    } catch (err) { logErr("Request disposal", err); return { error: err.message }; }
  }
  async function approveDisposal(assetId) {
    try {
      const updated = await api.approveDisposal(assetId);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`Disposal approved for ${assetId}. FAR updated${updated?.disposal?.reference ? ` — reference ${updated.disposal.reference}` : ""}.`);
      return { ok: true };
    } catch (err) { logErr("Approve disposal", err); return { error: err.message }; }
  }
  async function rejectDisposalFn(assetId, note) {
    try {
      const updated = await api.rejectDisposal(assetId, note);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`Disposal rejected for ${assetId}${note ? `: ${note}` : ""}.`);
      return { ok: true };
    } catch (err) { logErr("Reject disposal", err); return { error: err.message }; }
  }
  async function applyFairValue(assetId, value, justification) {
    try {
      const updated = await api.applyFairValue(assetId, value, justification, authUser?.name);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      log(`Fair value of ${fmtZAR(value)} applied to ${assetId}: ${justification}`);
    } catch (err) { logErr("Apply fair value", err); }
  }
  async function mergeAssets(group) {
    const [keep, ...rest] = group;
    try {
      const merged = await api.mergeAssets(keep.id, rest.map(r => r.id), authUser?.name);
      setAssets(prev => prev.filter(a => !rest.some(r => r.id === a.id)).map(a => a.id === keep.id ? merged : a));
      log(`Merged ${rest.length} duplicate record(s) into ${keep.id}.`);
    } catch (err) { logErr("Merge duplicates", err); }
  }
  async function bulkImport(rows) {
    try {
      const created = [];
      for (const r of rows) {
        const row = await api.addAsset(tenant.id, {
          barcode: r.barcode, desc: r.description, category: r.category, location: r.location || missions[0]?.name,
          custodian: r.custodian || "Unassigned", purchaseDate: r.purchaseDate || AS_OF.toISOString().slice(0, 10),
          price: r.price, costCentre: "CC-BULK", serial: "N/A", fundingSource: "Voted Funds",
          scoa: { fund: "Vote 06", func: "International Relations", item: r.category },
        });
        created.push(row);
      }
      setAssets(prev => [...created, ...prev]);
      log(`Bulk import: ${created.length} asset(s) imported.`);
    } catch (err) { logErr("Bulk import", err); }
  }

  /* ---------------- WIP ---------------- */
  async function addInvoice(projectId, ref, amount) {
    try { const row = await api.addWipInvoice(projectId, ref, amount);
      setWip(prev => prev.map(p => p.id === projectId ? { ...p, invoices: [...p.invoices, { id: row.id, ref, amount: Number(amount) }] } : p));
      log(`WIP invoice ${ref} of ${fmtZAR(amount)} recorded against project ${projectId}`);
    } catch (err) { logErr("Add WIP invoice", err); }
  }
  async function addRetention(projectId, pct, surety) {
    try { const row = await api.addWipRetention(projectId, pct, surety);
      setWip(prev => prev.map(p => p.id === projectId ? { ...p, retentions: [...p.retentions, { id: row.id, pct: Number(pct), surety }] } : p));
    } catch (err) { logErr("Add retention", err); }
  }
  async function addCession(projectId, beneficiary, amount) {
    try { const row = await api.addWipCession(projectId, beneficiary, amount);
      setWip(prev => prev.map(p => p.id === projectId ? { ...p, cessions: [...p.cessions, { id: row.id, beneficiary, amount: Number(amount) }] } : p));
    } catch (err) { logErr("Add cession", err); }
  }
  async function addBoq(projectId, item, amount) {
    try { const row = await api.addWipBoq(projectId, item, amount);
      setWip(prev => prev.map(p => p.id === projectId ? { ...p, boq: [...p.boq, { id: row.id, item, amount: Number(amount) }] } : p));
    } catch (err) { logErr("Add BOQ line", err); }
  }
  async function capitalise(projectId, lines) {
    const p = wip.find(x => x.id === projectId);
    try {
      const created = await api.capitaliseWip(tenant.id, projectId, lines, { location: missions[0]?.name });
      setAssets(prev => [...created, ...prev]);
      setWip(prev => prev.map(x => x.id === projectId ? { ...x, status: "Capitalised" } : x));
      log(`WIP project "${p.name}" unbundled into ${created.length} fixed asset(s) and capitalised.`);
    } catch (err) { logErr("Capitalise WIP project", err); }
  }

  /* ---------------- Verification ---------------- */
  async function planCycle(scope, due) {
    const inScope = assets.filter(a => a.location === scope && a.status !== "Disposed").map(a => a.id);
    try {
      const row = await api.planCycle(tenant.id, scope, due, inScope);
      setCycles(prev => [row, ...prev]);
      log(`Verification cycle planned for ${scope}: ${inScope.length} assets in scope.`);
      return row.id;
    } catch (err) { logErr("Plan verification cycle", err); }
  }
  async function scan(cycleId, barcode) {
    const cycle = cycles.find(c => c.id === cycleId);
    const asset = assets.find(a => a.barcode === barcode.trim());
    if (!asset) return { ok: false, text: "No asset found for barcode " + barcode };
    if (!cycle) return { ok: false, text: "Select a verification cycle first." };
    if (!cycle.assetIds.includes(asset.id)) {
      if (asset.location && asset.location !== cycle.scope) {
        const reason = `Physically found in ${cycle.scope} during verification, but registered to ${asset.location}. Auto-logged by ${authUser?.name || "system"} during scan.`;
        try {
          const subject = `[Verification Mismatch] Asset ${asset.barcode} (${asset.desc}) found in ${cycle.scope} but registered to ${asset.location} — for Head Office attention`;
          const row = await api.addTicket(tenant.id, subject, "High", "4h");
          setTickets(prev => [row, ...prev]);
          log(`Support ticket logged for Head Office — asset ${asset.barcode} found outside its registered mission.`);
        } catch (err) { logErr("Log mismatch ticket", err); }
        try {
          await api.requestAssetAction(tenant.id, asset.id, "Transfer", { newLocation: cycle.scope }, reason);
          const rows = await api.getActionRequests(tenant.id);
          setActionRequests(rows);
          log(`Automatic transfer request raised: ${asset.barcode} → ${cycle.scope} (pending Head Office approval).`);
        } catch (err) { logErr("Auto-transfer request", err); }
        return { ok: false, text: `${asset.desc} belongs to ${asset.location}, not ${cycle.scope} — a support ticket and an automatic transfer request have been logged for Head Office to review.` };
      }
      return { ok: false, text: `${asset.desc} is not in scope for this cycle.` };
    }
    if (cycle.verifiedIds.includes(asset.id)) return { ok: true, text: `${asset.desc} already verified in this cycle.` };
    try {
      const updatedCycle = await api.scanAssetIntoCycle(cycleId, asset.id, authUser?.name);
      setCycles(prev => prev.map(c => c.id === cycleId ? updatedCycle : c));
      log(`Asset verified via scan: ${asset.barcode} (${cycle.scope})`);
      return { ok: true, text: `Verified: ${asset.desc} at ${asset.location}` };
    } catch (err) { logErr("Scan asset", err); return { ok: false, text: "Scan failed — see activity log." }; }
  }
  async function closeCycleFn(id) {
    const cycle = cycles.find(c => c.id === id);
    const missingIds = cycle.assetIds.filter(aid => !cycle.verifiedIds.includes(aid));
    try {
      const updatedCycle = await api.closeCycle(id, missingIds);
      setAssets(prev => prev.map(a => missingIds.includes(a.id) ? { ...a, status: "Missing" } : a));
      setCycles(prev => prev.map(c => c.id === id ? updatedCycle : c));
      log(`Verification cycle closed for ${cycle.scope}. ${missingIds.length} exception(s) raised.`);
    } catch (err) { logErr("Close verification cycle", err); }
  }

  /* ---------------- Maintenance ---------------- */
  async function addMaintenanceReq(assetId, desc, due) {
    try { const row = await api.addMaintenance(tenant.id, assetId, desc, due);
      setMaintenance(prev => [{ id: row.id, assetId, desc, due, status: "Requested" }, ...prev]);
      log(`Maintenance logged for ${assetId}: ${desc}`);
    } catch (err) { logErr("Log maintenance", err); }
  }
  async function setMaintenanceStatusFn(id, status) {
    try { await api.setMaintenanceStatus(id, status); setMaintenance(prev => prev.map(m => m.id === id ? { ...m, status } : m)); }
    catch (err) { logErr("Update maintenance", err); }
  }

  /* ---------------- Quarterly Compliance ---------------- */
  async function captureDonation(donDesc, donor, donValue) {
    try {
      const row = await api.addAsset(tenant.id, { barcode: "DIRCO-DON" + Math.floor(Math.random() * 9000 + 1000), desc: donDesc, category: "Machinery & Equipment", location: missions[0]?.name, custodian: "Asset Management", purchaseDate: AS_OF.toISOString().slice(0, 10), price: donValue, costCentre: "CC-DON", serial: "N/A", fundingSource: "Donation", scoa: { fund: "Vote 06", func: "International Relations", item: "Donated Assets" } });
      setAssets(prev => [row, ...prev]);
      log(`Donated asset capitalised: ${donDesc} from ${donor}, ${fmtZAR(donValue)}`);
    } catch (err) { logErr("Capitalise donation", err); }
  }
  async function addCorrection(assetId, reason, evidence, approver) {
    try { const row = await api.addCorrectionJournal(tenant.id, assetId, reason, evidence, approver);
      setCorrectionJournals(prev => [{ id: row.id, assetId, reason, evidence, approver, ts: nowStamp() }, ...prev]);
      log(`Correction journal logged for ${assetId}: ${reason}`);
    } catch (err) { logErr("Log correction journal", err); }
  }

  /* ---------------- Security ---------------- */
  async function setTeamStatusFn(id, status) {
    try { await api.setTeamStatus(id, status); setTeam(prev => prev.map(u => u.id === id ? { ...u, status } : u));
      const u = team.find(x => x.id === id); log(`User ${u.name} ${status === "Suspended" ? "suspended" : "reactivated"}.`);
    } catch (err) { logErr("Update user status", err); }
  }
  async function confirmVettingFn(id) {
    try { await api.confirmVetting(id); setTeam(prev => prev.map(u => u.id === id ? { ...u, vetted: true, status: "Active" } : u));
      log("Security clearance confirmed — account activated.");
    } catch (err) { logErr("Confirm vetting", err); }
  }
  async function changeRoleFn(id, role) {
    try { await api.setTeamRole(id, role); setTeam(prev => prev.map(u => u.id === id ? { ...u, role } : u)); log(`Role updated: ${role}`); }
    catch (err) { logErr("Change role", err); }
  }
  function updatePasswordPolicyLocal(fields) { setPasswordPolicy(prev => ({ ...prev, ...fields })); }
  function savePasswordPolicy() {
    api.updatePasswordPolicy(tenant.id, { min_length: passwordPolicy.minLength, complexity: passwordPolicy.complexity, expiry_days: passwordPolicy.expiryDays, history_count: passwordPolicy.historyCount }).catch(err => logErr("Save password policy", err));
  }

  /* ---------------- Training ---------------- */
  async function setTrainingStatusFn(id, status) {
    try { await api.setTrainingStatus(id, status); setTraining(prev => prev.map(t => t.id === id ? { ...t, status, signedOff: status === "Completed" } : t)); }
    catch (err) { logErr("Update training", err); }
  }

  /* ---------------- GRAP Classes ---------------- */
  async function addClassFn(name, type, usefulLifeYears) {
    try { const row = await api.addClass(tenant.id, name, type, usefulLifeYears); setClasses(prev => [...prev, row]); }
    catch (err) { logErr("Add class", err); }
  }
  async function toggleClassActive(id, active) {
    try { await api.setClassActive(id, !active); setClasses(prev => prev.map(c => c.id === id ? { ...c, active: !active } : c)); }
    catch (err) { logErr("Update class", err); }
  }
  async function setClassUsefulLifeFn(id, years) {
    try { await api.setClassUsefulLife(id, years); setClasses(prev => prev.map(c => c.id === id ? { ...c, usefulLifeYears: years } : c)); log(`Useful life updated for classification.`); }
    catch (err) { logErr("Update useful life", err); }
  }
  async function createMissionFn(name, region) {
    try { const row = await api.createMission(tenant.id, name, region); setMissions(prev => [...prev, row].sort((a, b) => a.name.localeCompare(b.name))); log(`Mission defined: ${name}`); return { ok: true }; }
    catch (err) { logErr("Define mission", err); return { error: err.message }; }
  }
  async function updateMissionFn(id, fields) {
    try { const row = await api.updateMission(id, fields); setMissions(prev => prev.map(m => m.id === id ? row : m)); log(`Mission updated: ${row.name}`); }
    catch (err) { logErr("Update mission", err); }
  }

  /* ---------------- System Admin ---------------- */
  function runMigration() {
    setMigration(m => ({ ...m, status: "running" }));
    setTimeout(async () => {
      const migratedValue = assets.reduce((s, a) => s + a.price, 0);
      setMigration(m => ({ ...m, status: "complete" }));
      try { await api.recordMigrationRun(tenant.id, migration.legacyCount, migration.legacyValue, assets.length, migratedValue); }
      catch (err) { logErr("Record migration run", err); }
    }, 1200);
  }
  async function addTicketFn(subject, priority) {
    const sla = priority === "High" ? "4h" : priority === "Medium" ? "24h" : "72h";
    try { const row = await api.addTicket(tenant.id, subject, priority, sla); setTickets(prev => [{ id: row.id, subject, priority, due: sla, status: "Open" }, ...prev]); }
    catch (err) { logErr("Raise ticket", err); }
  }
  async function advanceTicketFn(id) {
    const t = tickets.find(x => x.id === id);
    const next = t.status === "Open" ? "In Progress" : "Resolved";
    try { await api.advanceTicket(id, next); setTickets(prev => prev.map(x => x.id === id ? { ...x, status: next } : x)); }
    catch (err) { logErr("Advance ticket", err); }
  }
  async function setMilestoneFn(id, status) {
    try { await api.setMilestoneStatus(id, status); setMilestones(prev => prev.map(m => m.id === id ? { ...m, status } : m)); }
    catch (err) { logErr("Update milestone", err); }
  }
  function updateGlLocal(id, code) { setGlMapping(prev => prev.map(g => g.id === id ? { ...g, glCode: code } : g)); }
  function saveGlCode(id, code) { api.updateGlCode(id, code).catch(err => logErr("Save GL mapping", err)); }

  /* ---------------- Derived ---------------- */
  const theme = tenant ? { name: tenant.theme_name || "Custom", primary: tenant.primary_color, accent: tenant.accent_color, secondary: tenant.secondary_color } : PRESETS[0];
  const orgName = tenant?.org_name || "DIRCO";
  const logo = tenant?.logo_url || null;
  const vars = { "--primary": theme.primary, "--accent": theme.accent, "--secondary": theme.secondary, "--ok": "#2E9E5B", "--warn": "#C9A227", "--danger": "#C0392B", "--muted": "#8A94A6" };

  const canConfigure = ["System Owner", "Mission Admin", "Head Office Admin"].includes(authUser?.role);
  const NAV = [
    { section: "Overview", items: [["dashboard", "Dashboard", LayoutGrid], ["approvals", "Approvals", ClipboardCheck]] },
    { section: "Assets", items: [
      ["register", "Asset Register", Boxes], ["depreciation", "Acquisitions & Depreciation", TrendingDown],
      ["wip", "WIP Projects", HardHat], ["maintenance", "Maintenance", Wrench], ["bulk", "Bulk Data & Documents", FileText],
    ]},
    { section: "Compliance", items: [
      ["grap", "GRAP Classification", Layers], ["scoa", "SCOA & Reporting", Landmark],
      ["verify", "Verification", ScanBarcode], ["quarterly", "Quarterly Compliance", ListChecks],
    ]},
    { section: "Admin", items: [
      ...(canConfigure ? [["configuration", "Configuration", Settings2]] : []),
      ["security", "Security & Access", ShieldCheck], ["training", "Training & Skills Transfer", GraduationCap], ["branding", "Branding", Palette],
    ]},
  ];

  if (loading) return <BootScreen state="loading" />;
  if (bootError) return <BootScreen state="error" error={bootError} />;
  if (!authUser) return <LoginScreen tenant={tenant} onSuccess={handleLoginSuccess} />;

  return (
    <div style={{ ...vars }} className="ams-root">
      <GlobalStyle />
      <aside className="sidebar">
        <div className="brand">
          {logo ? <img src={logo} alt="logo" /> : <div className="logo-fallback">{orgName.slice(0, 2).toUpperCase()}</div>}
          <div><div className="name">{orgName}</div><div className="sub">Asset Management</div></div>
        </div>
        {NAV.map(sec => (
          <div key={sec.section}>
            <div className="navlabel">{sec.section}</div>
            {sec.items.map(([key, label, Icon]) => {
              const pendingCount = key === "approvals" ? actionRequests.filter(r => r.status === "Pending").length + assets.filter(a => a.status === "Pending Disposal Approval").length : 0;
              return (
                <div key={key} className={"navitem" + (tab === key ? " active" : "")} onClick={() => setTab(key)}>
                  <Icon size={16} /><span>{label}</span>
                  {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
                </div>
              );
            })}
          </div>
        ))}
        <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div className="navitem" onClick={handleLogout}><LogOut size={16} /><span>Sign out</span></div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <h1>{tabTitle(tab)}</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="live-pill"><span className="dot" />Live — Postgres via Prisma/FastAPI</span>
            <NotificationBell actionRequests={actionRequests} assets={assets} onNavigate={() => setTab("approvals")} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setShowProfile(true)}>
              <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{authUser.name}</span>
              <div title={authUser.name} style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--accent)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{initials(authUser.name)}</div>
            </div>
          </div>
        </div>
        <div className="content">
          {tab === "dashboard" && <Dashboard assets={assets} wip={wip} maintenance={maintenance} cycles={cycles} missions={missions} glMapping={glMapping} activity={activity} authUser={authUser} logsLastRefresh={logsLastRefresh} logsRefreshing={logsRefreshing} onRefreshLogs={refreshLogsFn} onGoRegister={goToRegister} onGoVerify={() => setTab("verify")} onGoDepreciation={() => setTab("depreciation")} onNavigate={setTab} />}
          {tab === "approvals" && <ApprovalsView actionRequests={actionRequests} assets={assets} authUser={authUser} onApprove={approveActionRequestFn} onReject={rejectActionRequestFn} onApproveDisposal={approveDisposal} onRejectDisposal={rejectDisposalFn} />}
          {tab === "configuration" && <ConfigurationView missions={missions} team={team} authUser={authUser} tenant={tenant} onCreateMission={createMissionFn} onUpdateMission={updateMissionFn} onCreateUser={createUserFn} onStatus={setTeamStatusFn} onVet={confirmVettingFn} onDelete={deleteUserFn} migration={migration} onRunMigration={runMigration} tickets={tickets} onAddTicket={addTicketFn} onAdvanceTicket={advanceTicketFn} milestones={milestones} onSetMilestone={setMilestoneFn} glMapping={glMapping} onGlChange={updateGlLocal} onGlSave={saveGlCode} assets={assets} />}
          {tab === "register" && <RegisterView key={registerNav.key} initialStatusFilter={registerNav.status} assets={assets} classes={classes} missions={missions} team={team} authUser={authUser} onAddAsset={addAsset} onRequestAction={requestAssetActionFn} onRequestDisposal={requestDisposal} onEditAsset={editAssetFn} onAddPhoto={addPhoto} onAddDocument={addDocument} onLoadDetail={loadAssetDetailFn} />}
          {tab === "depreciation" && <DepreciationView assets={assets} classes={classes} missions={missions} team={team} authUser={authUser} onAddAsset={addAsset} onRequestAction={requestAssetActionFn} />}
          {tab === "wip" && <WipView wip={wip} onAddInvoice={addInvoice} onAddRetention={addRetention} onAddCession={addCession} onAddBoq={addBoq} onCapitalise={capitalise} />}
          {tab === "maintenance" && <MaintenanceView assets={assets} maintenance={maintenance} onAdd={addMaintenanceReq} onSetStatus={setMaintenanceStatusFn} />}
          {tab === "bulk" && <BulkDataView assets={assets} onImport={bulkImport} onMerge={mergeAssets} />}
          {tab === "grap" && <GrapView classes={classes} assets={assets} onAdd={addClassFn} onToggle={toggleClassActive} onSetUsefulLife={setClassUsefulLifeFn} />}
          {tab === "scoa" && <ScoaView assets={assets} />}
          {tab === "verify" && <VerifyView assets={assets} cycles={cycles} missions={missions} onPlan={planCycle} onScan={scan} onClose={closeCycleFn} />}
          {tab === "quarterly" && <QuarterlyView assets={assets} correctionJournals={correctionJournals} glMapping={glMapping} classes={classes} onDonate={captureDonation} onAddCorrection={addCorrection} log={log} />}
          {tab === "security" && <SecurityView team={team} loginAudit={loginAudit} passwordPolicy={passwordPolicy} authUser={authUser} missions={missions} logsLastRefresh={logsLastRefresh} logsRefreshing={logsRefreshing} onRefreshLogs={refreshLogsFn} onStatus={setTeamStatusFn} onVet={confirmVettingFn} onRole={changeRoleFn} onDelete={deleteUserFn} onPolicyChange={updatePasswordPolicyLocal} onPolicySave={savePasswordPolicy} onCreateUser={createUserFn} />}
          {tab === "training" && <TrainingView training={training} onSetStatus={setTrainingStatusFn} />}
          {tab === "branding" && <BrandingView theme={theme} setTheme={setTheme} orgName={orgName} setOrgName={setOrgName} logo={logo} onUploadClick={() => fileRef.current?.click()} onRemoveLogo={removeLogo} />}
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleLogoUpload} />
      {showProfile && <ProfilePanel authUser={authUser} onClose={() => setShowProfile(false)} onLogout={() => { setShowProfile(false); handleLogout(); }} />}
    </div>
  );
}

function dbFieldsFromUi(fields) {
  const map = { location: "location", custodian: "custodian", room: "room", category: "category", desc: "description" };
  const out = {};
  Object.entries(fields).forEach(([k, v]) => { out[map[k] || k] = v; });
  return out;
}

function tabTitle(tab) {
  return {
    dashboard: "Dashboard", approvals: "Approvals", configuration: "Configuration", register: "Asset Register", depreciation: "Acquisitions & Depreciation", wip: "Work-in-Progress Projects",
    maintenance: "Maintenance", bulk: "Bulk Data & Documents", grap: "GRAP Classification", scoa: "SCOA & Reporting",
    verify: "Physical Verification", quarterly: "Quarterly Compliance", security: "Security & Access",
    training: "Training & Skills Transfer", branding: "Branding & White-Label",
  }[tab];
}

/* =====================================================================
   BOOT SCREEN
===================================================================== */
function LoginScreen({ tenant, onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const orgName = tenant?.org_name || "DIRCO";
  const logo = tenant?.logo_url || null;
  const primary = tenant?.primary_color || "#152A4E";
  const accent = tenant?.accent_color || "#0E9C8F";

  async function submit(e) {
    e.preventDefault();
    if (!email || !password) { setError("Enter your email and password."); return; }
    setBusy(true); setError("");
    try {
      const user = await api.login(email, password);
      onSuccess(user);
    } catch (err) {
      setError(err.message || "Login failed.");
    }
    setBusy(false);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F4F6F9", fontFamily: "ui-sans-serif, sans-serif" }}>
      <form onSubmit={submit} style={{ width: 360, background: "#fff", borderRadius: 14, border: "1px solid #E3E7EE", padding: "32px 28px", boxShadow: "0 10px 30px rgba(20,30,50,0.08)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 22 }}>
          {logo ? (
            <img src={logo} alt={orgName} style={{ width: 56, height: 56, objectFit: "contain", borderRadius: 10, marginBottom: 10, background: "#fafbfd", border: "1px solid #E3E7EE" }} />
          ) : (
            <div style={{ width: 56, height: 56, borderRadius: 10, background: accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, marginBottom: 10 }}>{orgName.slice(0, 2).toUpperCase()}</div>
          )}
          <div style={{ fontWeight: 700, fontSize: 16, color: primary }}>{orgName}</div>
          <div style={{ fontSize: 12, color: "#667085", marginTop: 2 }}>Asset Management System</div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="field"><label>Email</label><input type="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="name@dirco.gov.za" /></div>
        <div className="field"><label>Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" /></div>
        <button type="submit" className="btn accent" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={busy}>{busy ? "Signing in…" : "Sign In"}</button>
        <div style={{ fontSize: 11, color: "#98A2B3", textAlign: "center", marginTop: 16 }}>Accounts are created by a System Owner or Mission Admin under Security & Access.</div>
      </form>
      <style>{`
        .field { margin-bottom: 14px; text-align: left; }
        .field label { display: block; font-size: 12px; font-weight: 600; color: #667085; margin-bottom: 5px; }
        .field input { width: 100%; border: 1px solid #E3E7EE; border-radius: 8px; padding: 10px 11px; font-size: 13px; box-sizing: border-box; }
        .btn { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 8px; padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .btn.accent { background: ${accent}; color: #fff; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .error-banner { background: #FCEBEA; color: #C0392B; border: 1px solid #F3C9C6; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 14px; }
      `}</style>
    </div>
  );
}

function BootScreen({ state, error }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F4F6F9", fontFamily: "ui-sans-serif, sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 460 }}>
        {state === "loading" ? (
          <>
            <Loader2 size={28} className="spin" color="#152A4E" />
            <div style={{ marginTop: 12, fontSize: 14, color: "#1A2233", fontWeight: 600 }}>Loading live data from the API…</div>
          </>
        ) : (
          <>
            <AlertTriangle size={28} color="#C0392B" />
            <div style={{ marginTop: 12, fontSize: 14, color: "#1A2233", fontWeight: 700 }}>Couldn't reach the backend API</div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: "#667085" }}>{String(error?.message || error)}</div>
            <div style={{ marginTop: 14, fontSize: 12, color: "#667085", textAlign: "left", background: "#fff", border: "1px solid #E3E7EE", borderRadius: 8, padding: 14 }}>
              Check that:
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>The FastAPI backend is running (<code>uvicorn app.main:app --reload</code> from <code>backend/</code>)</li>
                <li>You ran <code>prisma generate</code> and <code>prisma db push</code> from <code>backend/</code> against your Postgres database</li>
                <li><code>VITE_API_URL</code> in the frontend's <code>.env</code> points at the backend (default <code>http://localhost:8000</code>)</li>
                <li>Backend <code>.env</code> has a valid <code>DATABASE_URL</code> and <code>CORS_ORIGINS</code> includes the frontend's URL</li>
              </ul>
            </div>
          </>
        )}
      </div>
      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* =====================================================================
   SHARED UI
===================================================================== */
function Badge({ color, icon: Icon, children }) {
  return <span className="badge" style={{ background: color + "1A", color }}>{Icon && <Icon size={12} />} {children}</span>;
}
function Modal({ onClose, width = 560, children }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width }}>{children}</div>
    </div>
  );
}
function Field({ label, children }) { return <div className="field"><label>{label}</label>{children}</div>; }
function Tabs({ tabs, active, onChange }) {
  return <div className="tabs">{tabs.map(t => <div key={t} className={"tab" + (t === active ? " active" : "")} onClick={() => onChange(t)}>{t}</div>)}</div>;
}
function NotificationBell({ actionRequests, assets, onNavigate }) {
  const [open, setOpen] = useState(false);
  const pendingRequests = actionRequests.filter(r => r.status === "Pending");
  const pendingDisposals = assets.filter(a => a.status === "Pending Disposal Approval");
  const items = [
    ...pendingRequests.map(r => ({ id: r.id, text: `${r.type} requested for ${r.assetDesc || r.assetId}`, sub: `by ${r.requestedBy}` })),
    ...pendingDisposals.map(a => ({ id: a.id, text: `Disposal requested for ${a.desc}`, sub: a.disposal?.method || "" })),
  ];
  const count = items.length;
  return (
    <span style={{ position: "relative" }}>
      <span style={{ position: "relative", cursor: "pointer" }} onClick={() => setOpen(o => !o)}>
        <Bell size={18} color="var(--text-dim)" />
        {count > 0 && <span className="bell-badge">{count > 9 ? "9+" : count}</span>}
      </span>
      {open && (
        <>
          <div className="infotip-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-panel">
            <div className="notif-head">Notifications {count > 0 && `(${count} pending)`}</div>
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {items.length === 0 && <div className="hint" style={{ padding: "10px 12px" }}>Nothing needs your attention right now.</div>}
              {items.slice(0, 10).map(it => (
                <div key={it.id} className="notif-item" onClick={() => { setOpen(false); onNavigate(); }}>
                  <div style={{ fontSize: 12.5 }}>{it.text}</div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{it.sub}</div>
                </div>
              ))}
            </div>
            {count > 0 && <div className="notif-footer" onClick={() => { setOpen(false); onNavigate(); }}>View all in Approvals →</div>}
          </div>
        </>
      )}
    </span>
  );
}

function ProfilePanel({ authUser, onClose, onLogout }) {
  return (
    <Modal onClose={onClose} width={380}>
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2>My Profile</h2><X size={18} style={{ cursor: "pointer" }} onClick={onClose} /></div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "14px 0 18px" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--accent)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 }}>{initials(authUser.name)}</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{authUser.name}</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{authUser.email}</div>
        </div>
      </div>
      <div className="detail-panel">
        <div className="kv"><span>Role</span><span>{authUser.role}</span></div>
        <div className="kv"><span>Mission</span><span>{authUser.missionName || "— all missions —"}</span></div>
        <div className="kv"><span>Status</span><span><Badge color={authUser.status === "Active" ? "var(--ok)" : "var(--warn)"}>{authUser.status}</Badge></span></div>
        <div className="kv"><span>Last Login</span><span>{authUser.lastLogin}</span></div>
      </div>
      <button className="btn ghost" style={{ width: "100%", justifyContent: "center", marginTop: 16 }} onClick={onLogout}><LogOut size={14} /> Sign Out</button>
    </Modal>
  );
}

function ProgressBar({ pct, color }) {
  return <div className="progress-bar"><div className="progress-fill" style={{ width: pct + "%", background: color || "var(--accent)" }} /></div>;
}
function InfoTip({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="infotip-wrap">
      <button type="button" className="infotip-btn" onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }} aria-label={`What does "${title}" mean?`}>
        <Info size={12} />
      </button>
      {open && (
        <>
          <div className="infotip-backdrop" onClick={() => setOpen(false)} />
          <div className="infotip-panel" onClick={e => e.stopPropagation()}>
            <div className="infotip-head">
              <span>{title}</span>
              <X size={13} style={{ cursor: "pointer" }} onClick={() => setOpen(false)} />
            </div>
            <div className="infotip-body">{children}</div>
          </div>
        </>
      )}
    </span>
  );
}

/* =====================================================================
   DASHBOARD
===================================================================== */
const FY_START = "2025-04-01";
const DASHBOARD_COLORS = ["var(--primary)", "var(--accent)", "var(--secondary)", "#8A94A6", "#C0392B", "#2E9E5B", "#3B82F6"];

function Dashboard({ assets, wip, maintenance, cycles, missions, glMapping, activity, authUser, logsLastRefresh, logsRefreshing, onRefreshLogs, onGoRegister, onGoVerify, onGoDepreciation, onNavigate }) {
  const stats = useMemo(() => {
    const totalValue = assets.reduce((s, a) => s + a.price, 0);
    const additions = assets.filter(a => a.purchaseDate >= FY_START);
    const disposalsFY = assets.filter(a => a.status === "Disposed" && a.disposal?.date >= FY_START);
    const openCycles = cycles.filter(c => !c.closed);
    const dueForVerification = openCycles.reduce((s, c) => s + (c.assetIds.length - c.verifiedIds.length), 0);
    const verifiedTotal = new Set(cycles.flatMap(c => c.verifiedIds)).size;
    const inScopeTotal = new Set(cycles.flatMap(c => c.assetIds)).size;
    const verifiedPct = inScopeTotal ? Math.round((verifiedTotal / inScopeTotal) * 100) : 0;
    const underMaintenance = maintenance.filter(m => m.status !== "Completed").length;
    const wipValue = wip.filter(w => w.status !== "Capitalised").reduce((s, w) => s + w.budget, 0);
    const missing = assets.filter(a => a.status === "Missing").length;
    const available = assets.filter(a => a.status === "Available").length;

    const byCategory = {};
    assets.forEach(a => { byCategory[a.category] = (byCategory[a.category] || 0) + 1; });
    const categoryRows = Object.entries(byCategory).map(([name, count]) => ({ name, count, pct: Math.round(count / (assets.length || 1) * 100) })).sort((a, b) => b.count - a.count);

    const byLocation = {};
    assets.forEach(a => { const loc = a.location || "Unassigned"; byLocation[loc] = (byLocation[loc] || 0) + 1; });
    const locationRows = Object.entries(byLocation).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    const byStatus = {};
    assets.forEach(a => { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });
    const statusRows = Object.entries(byStatus).map(([name, count]) => ({ name, count, pct: Math.round(count / (assets.length || 1) * 100) }));

    const recentAdditions = [...assets].sort((a, b) => (b.purchaseDate || "").localeCompare(a.purchaseDate || "")).slice(0, 5);

    const noCustodian = assets.filter(a => a.status === "In Use" && !a.custodian).length;
    const zeroValueInUse = assets.filter(a => a.price === 0 && a.status === "In Use").length;
    const dueMaintenance = maintenance.filter(m => m.status === "Requested").length;
    const mappedCategories = new Set(glMapping.filter(g => g.glCode).map(g => g.category));
    const notLinkedToGl = assets.filter(a => !mappedCategories.has(a.category)).length;

    return {
      totalValue, additions, disposalsFY, dueForVerification, verifiedPct, underMaintenance, wipValue,
      missing, available, categoryRows, locationRows, statusRows, recentAdditions,
      noCustodian, zeroValueInUse, dueMaintenance, notLinkedToGl,
    };
  }, [assets, wip, maintenance, cycles, glMapping]);

  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(7, 1fr)" }}>
        <Kpi label="Total Assets" value={assets.length.toLocaleString()} delta={fmtZAR(stats.totalValue)} up icon={Boxes} onClick={() => onGoRegister("All")}
          info="Every asset currently in the Fixed Asset Register, regardless of status. Click to view the full register." />
        <Kpi label="New Additions (FY)" value={stats.additions.length} delta={fmtZAR(stats.additions.reduce((s, a) => s + a.price, 0))} up icon={TrendingUp} onClick={() => onNavigate("depreciation")}
          info="Assets acquired since the start of this financial year. Click to see the Acquisitions panel." />
        <Kpi label="Disposals (FY)" value={stats.disposalsFY.length} delta={fmtZAR(stats.disposalsFY.reduce((s, a) => s + (a.disposal?.value || 0), 0))} icon={TrendingDown} onClick={() => onGoRegister("Disposed")}
          info="Assets disposed of (sold, scrapped, donated, written off) since the start of this financial year." />
        <Kpi label="Due for Verification" value={stats.dueForVerification} delta="in open cycles" danger={stats.dueForVerification > 0} icon={ClipboardList} onClick={onGoVerify}
          info="Assets in an open verification cycle that haven't been scanned yet. Click to open Verification." />
        <Kpi label="Assets Verified" value={stats.verifiedPct + "%"} delta="of assets ever in a cycle" up icon={ShieldCheck} onClick={onGoVerify}
          info="Percentage of all assets that have ever been part of a verification cycle that have been successfully scanned and confirmed." />
        <Kpi label="Under Maintenance" value={stats.underMaintenance} delta="requested or scheduled" icon={Wrench} onClick={() => onNavigate("maintenance")}
          info="Maintenance requests that are logged but not yet marked complete. Click to see the Maintenance schedule." />
        <Kpi label="WIP Projects" value={wip.length} delta={fmtZAR(stats.wipValue)} icon={HardHat} onClick={() => onNavigate("wip")}
          info="Capital projects still in progress (not yet capitalised into the register), and their combined budget." />
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>Assets by Category <InfoTip title="Assets by Category">Live breakdown of every asset in the register by its GRAP classification.</InfoTip></h3>
          <ResponsiveContainer width="100%" height={170}>
            <PieChart>
              <Pie data={stats.categoryRows} dataKey="count" nameKey="name" innerRadius={40} outerRadius={65} paddingAngle={2}>
                {stats.categoryRows.map((_, i) => <Cell key={i} fill={DASHBOARD_COLORS[i % DASHBOARD_COLORS.length]} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11.5 }}>{stats.categoryRows.map((c, i) => (
            <div key={c.name} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: DASHBOARD_COLORS[i % DASHBOARD_COLORS.length], display: "inline-block" }} />{c.name}</span>
              <span style={{ color: "var(--text-dim)" }}>{c.pct}% · {c.count}</span>
            </div>
          ))}</div>
        </div>

        <div className="card">
          <h3>Assets by Location <InfoTip title="Assets by Location">Live count of assets per mission — replaces a hardcoded location list; missions are managed on the Configuration screen.</InfoTip></h3>
          <div className="hint">{missions.length} mission{missions.length === 1 ? "" : "s"} + Head Office</div>
          {stats.locationRows.map(l => {
            const pct = Math.round(l.count / (assets.length || 1) * 100);
            return (
              <div key={l.name} style={{ marginBottom: 9, cursor: "pointer" }} onClick={() => onNavigate("register")}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span>{l.name}</span><span style={{ color: "var(--text-dim)" }}>{l.count}</span></div>
                <ProgressBar pct={pct} color="var(--accent)" />
              </div>
            );
          })}
        </div>

        <div className="card">
          <h3>Asset Status <InfoTip title="Asset Status">Live breakdown of every asset by current status.</InfoTip></h3>
          <ResponsiveContainer width="100%" height={170}>
            <PieChart>
              <Pie data={stats.statusRows} dataKey="count" nameKey="name" innerRadius={40} outerRadius={65} paddingAngle={2}>
                {stats.statusRows.map((r, i) => <Cell key={i} fill={(statusMeta[r.name] || {}).color || "var(--muted)"} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11.5 }}>{stats.statusRows.map(r => (
            <div key={r.name} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: (statusMeta[r.name] || {}).color || "var(--muted)", display: "inline-block" }} />{r.name}</span>
              <span style={{ color: "var(--text-dim)" }}>{r.count} ({r.pct}%)</span>
            </div>
          ))}</div>
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>Recent Asset Additions <InfoTip title="Recent Additions">The 5 most recently acquired assets by purchase date.</InfoTip></h3>
          <table>
            <thead><tr><th>Barcode</th><th>Description</th><th>Location</th><th>Date</th></tr></thead>
            <tbody>{stats.recentAdditions.map(a => (
              <tr key={a.id} className="row" onClick={() => onGoRegister("All")}>
                <td style={{ fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{a.barcode}</td>
                <td style={{ fontSize: 12 }}>{a.desc}</td>
                <td style={{ fontSize: 12, color: "var(--text-dim)" }}>{a.location || "Unassigned"}</td>
                <td style={{ fontSize: 12 }}>{a.purchaseDate}</td>
              </tr>
            ))}</tbody>
          </table>
          {stats.recentAdditions.length === 0 && <div className="hint">No assets captured yet.</div>}
        </div>

        <div className="card">
          <h3>Upcoming Verifications <InfoTip title="Upcoming Verifications">Verification cycles that are still open, soonest due date first.</InfoTip></h3>
          {[...cycles].filter(c => !c.closed).sort((a, b) => (a.due || "").localeCompare(b.due || "")).map(c => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px dashed var(--border)", cursor: "pointer" }} onClick={onGoVerify}>
              <span style={{ fontSize: 12.5 }}>{c.scope}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{c.due}</span><Badge color="var(--warn)">{c.verifiedIds.length}/{c.assetIds.length}</Badge></span>
            </div>
          ))}
          {cycles.filter(c => !c.closed).length === 0 && <div className="hint">No open verification cycles.</div>}
        </div>

        <div className="card">
          <h3>Alerts & Exceptions <InfoTip title="Alerts & Exceptions">Data-quality and compliance flags worth reviewing — none of these block anything, they're just worth investigating.</InfoTip></h3>
          <div className="alert-row" onClick={onGoVerify}><CircleAlert size={14} color="var(--danger)" /><span>Assets not yet verified</span><b>{stats.dueForVerification}</b></div>
          <div className="alert-row" onClick={() => onGoRegister("In Use")}><AlertTriangle size={14} color="var(--warn)" /><span>In Use with no custodian</span><b>{stats.noCustodian}</b></div>
          <div className="alert-row" onClick={() => onNavigate("maintenance")}><Wrench size={14} color="var(--accent)" /><span>Maintenance not yet scheduled</span><b>{stats.dueMaintenance}</b></div>
          <div className="alert-row" onClick={() => onNavigate("depreciation")}><Info size={14} color="var(--secondary)" /><span>Zero value but In Use</span><b>{stats.zeroValueInUse}</b></div>
          <div className="alert-row" onClick={() => onNavigate("configuration")}><Landmark size={14} color="var(--ok)" /><span>Category not linked to GL</span><b>{stats.notLinkedToGl}</b></div>
        </div>
      </div>

      <div className="card">
        <h3>Quick Actions</h3>
        <div className="quick-actions">
          <button className="qa-btn" onClick={() => onGoRegister("All")}><Plus size={18} /> Add New Asset</button>
          <button className="qa-btn" onClick={() => onGoRegister("All")}><ArrowRightLeft size={18} /> Asset Transfer</button>
          <button className="qa-btn" onClick={() => onNavigate("depreciation")}><TrendingDown size={18} /> Dispose Asset</button>
          <button className="qa-btn" onClick={onGoVerify}><ScanBarcode size={18} /> Start Verification</button>
          <button className="qa-btn" onClick={() => onNavigate("wip")}><HardHat size={18} /> WIP Projects</button>
          <button className="qa-btn" onClick={() => onNavigate("scoa")}><FileText size={18} /> Reports</button>
          <button className="qa-btn" onClick={() => onNavigate("approvals")}><ClipboardCheck size={18} /> Approvals</button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ marginBottom: 0 }}>Recent Activity <InfoTip title="Recent Activity">A live, timestamped feed of actions taken anywhere in the system, attributed to who did them. Stored permanently so it survives a page refresh, and can be exported for audit purposes.</InfoTip></h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {logsLastRefresh && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Updated {logsLastRefresh.toLocaleTimeString()}</span>}
            <button className="btn ghost" onClick={onRefreshLogs} disabled={logsRefreshing}><RefreshCw size={13} className={logsRefreshing ? "spin" : ""} /> Refresh</button>
            <button className="btn ghost" onClick={() => {
              const header = "Timestamp,Message\n";
              const body = activity.map(a => [a.ts, a.msg].map(v => `"${(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
              downloadText(`activity_log_${new Date().toISOString().slice(0, 10)}.csv`, header + body + "\n");
            }}><Download size={13} /> Export CSV</button>
          </div>
        </div>
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          {activity.slice(0, 8).map(a => (
            <div key={a.id} style={{ fontSize: 12.5, padding: "7px 0", borderBottom: "1px dashed var(--border)" }}>
              <div>{a.msg}</div><div style={{ color: "var(--text-dim)", fontSize: 11 }}>{a.ts}</div>
            </div>
          ))}
          {activity.length === 0 && <div className="hint">No activity yet.</div>}
        </div>
      </div>
    </>
  );
}
function Kpi({ label, value, delta, up, danger, icon: Icon, info, onClick }) {
  return (
    <div className="card kpi" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="label">{label}{info && <InfoTip title={label}>{info}</InfoTip>}</div><Icon size={16} color="var(--text-dim)" />
      </div>
      <div className="value">{value}</div>
      <div className="delta" style={{ color: danger ? "var(--danger)" : up ? "var(--ok)" : "var(--text-dim)" }}>{up && <TrendingUp size={12} />} {delta}</div>
    </div>
  );
}

/* =====================================================================
   APPROVALS — a unified queue for anything that needs sign-off before
   it touches the FAR: transfers, reclassifications, fair valuations, and
   (mirrored here for convenience) pending disposals.
===================================================================== */
function ApprovalsView({ actionRequests, assets, authUser, onApprove, onReject, onApproveDisposal, onRejectDisposal }) {
  const [reviewing, setReviewing] = useState(null); // {kind:'request'|'disposal', id, action:'approve'|'reject'}
  const [note, setNote] = useState("");
  const [reviewError, setReviewError] = useState("");
  const isAdmin = ["System Owner", "Head Office Admin", "Mission Admin"].includes(authUser?.role);
  const isTopRole = ["System Owner", "Head Office Admin"].includes(authUser?.role);

  const pending = actionRequests.filter(r => r.status === "Pending");
  const reviewed = actionRequests.filter(r => r.status !== "Pending").slice(0, 15);
  const pendingDisposals = assets.filter(a => a.status === "Pending Disposal Approval");

  function payloadSummary(r) {
    if (r.type === "Transfer") return r.payload.offboard ? "→ Return to store (unassign)" : `→ ${r.payload.newLocation || "—"} (${r.payload.newCustodian || "unassigned"})`;
    if (r.type === "Reclassification") return `→ ${r.payload.newCategory}`;
    if (r.type === "Fair Valuation") return `→ ${fmtZAR(r.payload.value)}`;
    return "";
  }

  // Defense-in-depth: even though the backend already excludes requests a
  // Mission Admin can't act on, don't show Approve/Reject controls for a
  // cross-mission transfer if one somehow still appears in the list.
  function canActOnRequest(r) {
    if (isTopRole) return true;
    if (authUser?.role !== "Mission Admin") return false;
    if (r.type === "Transfer" && !r.payload.offboard && r.payload.newLocation && r.assetLocation && r.payload.newLocation !== r.assetLocation) return false;
    return true;
  }

  async function confirmReview() {
    if (reviewing.kind === "disposal" && reviewing.action === "reject" && !note.trim()) {
      setReviewError("A reason is required to decline a disposal request.");
      return;
    }
    let res;
    if (reviewing.kind === "disposal") {
      res = reviewing.action === "approve" ? await onApproveDisposal(reviewing.id) : await onRejectDisposal(reviewing.id, note);
    } else {
      res = reviewing.action === "approve" ? await onApprove(reviewing.id, note) : await onReject(reviewing.id, note);
    }
    if (res?.error) { setReviewError(res.error); return; }
    setReviewing(null); setNote(""); setReviewError("");
  }

  return (
    <>
      <div className="card">
        <h3>Pending Approvals <InfoTip title="Approval Workflow">Transfers, reclassifications, and fair valuations no longer take effect immediately — they're submitted here first and only applied to the FAR once approved. Mission Admins can approve in-mission actions; a transfer to any other mission (including Head Office) always needs Head Office Admin or System Owner sign-off, and won't appear in a Mission Admin's queue at all if they can't act on it.</InfoTip></h3>
        <div className="hint">{isAdmin ? "Review and approve or reject requests below." : `Signed in as ${authUser?.role} — only System Owner, Head Office Admin, and Mission Admin can approve or reject requests.`}</div>
        <table>
          <thead><tr><th>Asset</th><th>Type</th><th>Change</th><th>Requested By</th><th>Reason</th><th /></tr></thead>
          <tbody>{pending.map(r => (
            <tr key={r.id}>
              <td>{r.assetDesc || r.assetId} <span style={{ color: "var(--text-dim)", fontFamily: "ui-monospace,monospace", fontSize: 11 }}>({r.assetBarcode})</span></td>
              <td><Badge color="var(--warn)">{r.type}</Badge></td>
              <td style={{ fontSize: 12.5 }}>{payloadSummary(r)}</td>
              <td>{r.requestedBy}</td>
              <td style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{r.reason || "—"}</td>
              <td>{canActOnRequest(r) && (<div style={{ display: "flex", gap: 6 }}>
                <button className="btn accent" onClick={() => setReviewing({ kind: "request", id: r.id, action: "approve" })}>Approve</button>
                <button className="btn ghost" onClick={() => setReviewing({ kind: "request", id: r.id, action: "reject" })}>Reject</button>
              </div>)}</td>
            </tr>
          ))}</tbody>
        </table>
        {pending.length === 0 && <div className="hint">No pending transfer/reclassification/fair-value requests.</div>}
      </div>

      <div className="card">
        <h3>Pending Disposals <InfoTip title="Disposal Approval">Fixed rule: disposals always go to <b>Head Office Admin or System Owner</b> — Mission Admins can request a disposal but cannot approve or decline one, even for their own mission's assets. Declining always requires a reason, which is logged to the asset's audit trail and visible to the mission (since the asset's status change is visible in their own Asset Register). Approving marks the asset Disposed; declining restores its previous status.</InfoTip></h3>
        {pendingDisposals.length === 0 && <div className="hint">No disposals pending approval.</div>}
        {pendingDisposals.map(a => (
          <div key={a.id} style={{ borderBottom: "1px dashed var(--border)", padding: "8px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div><b>{a.desc}</b><div style={{ fontSize: 12, color: "var(--text-dim)" }}>{a.disposal?.method} · {a.disposal?.reason} · Est. value {fmtZAR(a.disposal?.value)}</div></div>
              {isTopRole ? (<div style={{ display: "flex", gap: 6 }}>
                <button className="btn accent" onClick={() => setReviewing({ kind: "disposal", id: a.id, action: "approve" })}>Approve</button>
                <button className="btn ghost" onClick={() => setReviewing({ kind: "disposal", id: a.id, action: "reject" })}>Decline</button>
              </div>) : <Badge color="var(--warn)">Awaiting Head Office</Badge>}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Recently Reviewed</h3>
        <div className="hint">Last 15 approved or rejected requests.</div>
        {reviewed.map(r => (
          <div key={r.id} style={{ fontSize: 12.5, padding: "6px 0", borderBottom: "1px dashed var(--border)", display: "flex", justifyContent: "space-between" }}>
            <span><b>{r.type}</b> — {r.assetDesc || r.assetId} <span style={{ color: "var(--text-dim)" }}>by {r.requestedBy}</span></span>
            <span><Badge color={r.status === "Approved" ? "var(--ok)" : "var(--danger)"}>{r.status}</Badge> <span style={{ color: "var(--text-dim)" }}>{r.reviewedBy && `— ${r.reviewedBy}`}</span></span>
          </div>
        ))}
        {reviewed.length === 0 && <div className="hint">Nothing reviewed yet.</div>}
      </div>

      {reviewing && (
        <Modal onClose={() => setReviewing(null)} width={420}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><h2>{reviewing.kind === "disposal" ? (reviewing.action === "approve" ? "Approve Disposal" : "Decline Disposal") : (reviewing.action === "approve" ? "Approve Request" : "Reject Request")}</h2><X size={18} style={{ cursor: "pointer" }} onClick={() => { setReviewing(null); setReviewError(""); }} /></div>
          {reviewError && <div className="error-banner">{reviewError}</div>}
          <Field label={reviewing.kind === "disposal" && reviewing.action === "reject" ? "Reason (required)" : "Note (optional)"}><input value={note} onChange={e => setNote(e.target.value)} placeholder={reviewing.action === "approve" ? "Any comments" : "Reason for rejection"} /></Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={reviewing.action === "approve" ? "btn accent" : "btn"} style={reviewing.action === "reject" ? { background: "var(--danger)" } : undefined} onClick={confirmReview}>{reviewing.action === "approve" ? "Confirm Approval" : "Confirm Rejection"}</button>
            <button className="btn ghost" onClick={() => { setReviewing(null); setReviewError(""); }}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* =====================================================================
   CONFIGURATION — the one-stop setup screen: Super User defines missions
   and assigns Mission Admins; Mission Admins configure custodians/officers
   for their own mission from here too.
===================================================================== */
function ConfigurationView({ missions, team, authUser, tenant, onCreateMission, onUpdateMission, onCreateUser, onStatus, onVet, onDelete, migration, onRunMigration, tickets, onAddTicket, onAdvanceTicket, milestones, onSetMilestone, glMapping, onGlChange, onGlSave, assets }) {
  const isSystemOwner = authUser?.role === "System Owner";
  const isMissionAdmin = authUser?.role === "Mission Admin";
  const isSystemConfigRole = ["System Owner", "Head Office Admin"].includes(authUser?.role);
  const [missionName, setMissionName] = useState("");
  const [missionRegion, setMissionRegion] = useState("");
  const [missionError, setMissionError] = useState("");
  const [createFor, setCreateFor] = useState(null); // { role, missionId } | null
  const [subject, setSubject] = useState(""); const [priority, setPriority] = useState("Medium");

  const subTabs = [
    ...(isSystemOwner ? ["Missions", "Admins"] : []),
    "Team & Custodians",
    ...(isSystemConfigRole ? ["GL Mapping", "Migration", "Project Plan"] : []),
    "Support Tickets",
  ];
  const [subTab, setSubTab] = useState(subTabs[0]);

  async function addMission() {
    if (!missionName) return;
    const res = await onCreateMission(missionName, missionRegion || null);
    if (res?.error) { setMissionError(res.error); return; }
    setMissionError(""); setMissionName(""); setMissionRegion("");
  }
  function raiseTicket() { if (!subject) return; onAddTicket(subject, priority); setSubject(""); }
  const migratedValue = assets.reduce((s, a) => s + a.price, 0);

  const adminsByMission = useMemo(() => {
    const map = {};
    missions.forEach(m => { map[m.id] = team.filter(u => u.missionName === m.name && u.role === "Mission Admin"); });
    return map;
  }, [missions, team]);

  function canDeleteUser(u) {
    if (authUser?.role === "System Owner" || authUser?.role === "Head Office Admin") return true;
    if (authUser?.role === "Mission Admin") return u.role === "Custodian";
    return false;
  }
  function handleDelete(u) {
    if (window.confirm(`Remove ${u.name} from the roster? This cannot be undone.`)) onDelete(u.id);
  }

  return (
    <>
      <div className="card" style={{ paddingBottom: 4 }}>
        <Tabs tabs={subTabs} active={subTab} onChange={setSubTab} />
      </div>

      {subTab === "Missions" && (
        <div className="card">
          <h3>Missions <InfoTip title="Missions">Define every mission DIRCO operates — Head Office counts as one too. <b>Region</b> is informational grouping only (e.g. for reporting) — it no longer affects transfer approvals, which now follow one fixed rule (see below). Once a mission exists, assign it a Mission Admin, who can then create custodians for that mission on their own.</InfoTip></h3>
          <div className="hint">As System Owner, you're the only one who can add or edit missions.</div>
          {missionError && <div className="error-banner">{missionError}</div>}
          <div className="row2" style={{ marginBottom: 14 }}>
            <input value={missionName} onChange={e => setMissionName(e.target.value)} placeholder="e.g. Mission: Berlin" />
            <input value={missionRegion} onChange={e => setMissionRegion(e.target.value)} placeholder="Region (e.g. Europe)" />
          </div>
          <button className="btn accent" style={{ marginBottom: 14 }} onClick={addMission}><Plus size={14} /> Define Mission</button>
          <table>
            <thead><tr><th>Mission</th><th>Region</th><th>Mission Admin(s)</th><th /></tr></thead>
            <tbody>{missions.map(m => (
              <tr key={m.id}>
                <td>{m.name} {m.isHeadOffice && <Badge color="var(--secondary)">Head Office</Badge>}</td>
                <td><input defaultValue={m.region || ""} placeholder="—" style={{ width: 110 }} onBlur={e => { if (e.target.value !== (m.region || "")) onUpdateMission(m.id, { region: e.target.value || null }); }} /></td>
                <td>{adminsByMission[m.id]?.length ? adminsByMission[m.id].map(a => <Badge key={a.id} color="var(--accent)">{a.name}</Badge>) : <span className="hint" style={{ margin: 0 }}>No admin assigned yet</span>}</td>
                <td><button className="btn ghost" onClick={() => setCreateFor({ role: "Mission Admin", missionId: m.id })}><Plus size={13} /> Assign Admin</button></td>
              </tr>
            ))}</tbody>
          </table>
          {missions.length === 0 && <div className="hint">No missions defined yet — add one above to get started.</div>}
          <div className="hint" style={{ marginTop: 10 }}><b>Transfer approval rule (fixed):</b> a transfer within the same mission is approvable by that mission's admin. A transfer to <b>any</b> other mission — including Head Office — always requires Head Office Admin or System Owner sign-off. No exceptions.</div>
        </div>
      )}

      {subTab === "Admins" && (
        <div className="card">
          <h3>Head Office Admins <InfoTip title="Head Office Admins">These accounts see every mission's data and approve cross-mission transfers, but — unlike you — can't define missions or create other admin accounts.</InfoTip></h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {team.filter(u => u.role === "Head Office Admin").map(u => <Badge key={u.id} color="var(--secondary)">{u.name}</Badge>)}
            {team.filter(u => u.role === "Head Office Admin").length === 0 && <span className="hint">None created yet.</span>}
          </div>
          <button className="btn accent" onClick={() => setCreateFor({ role: "Head Office Admin", missionId: null })}><Plus size={14} /> Create Head Office Admin</button>
        </div>
      )}

      {subTab === "Team & Custodians" && (
        <div className="card">
          <h3>{isMissionAdmin ? `Custodians & Team — ${authUser.missionName}` : "Custodians & Operational Team"} <InfoTip title="Custodians & Team">{isMissionAdmin ? "Create and manage the officers and custodians who work within your mission. Custodians are employee records only — they don't get a system login." : "Every operational user across every mission — Mission Admins manage their own mission's roster day-to-day."}</InfoTip></h3>
          <div className="hint">{isMissionAdmin ? "New logins start Pending Vetting — confirm clearance to activate them. Custodians are active immediately since they have no login." : "Read-only overview across all missions."}</div>
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Mission</th><th>Status</th><th /></tr></thead>
            <tbody>{team.filter(u => u.role !== "System Owner" && u.role !== "Head Office Admin" && u.role !== "Mission Admin").map(u => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{u.email || <Badge color="var(--muted)">No login</Badge>}</td>
                <td>{u.role}</td>
                <td style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{u.missionName || "—"}</td>
                <td><Badge color={u.status === "Active" ? "var(--ok)" : u.status === "Pending Vetting" ? "var(--warn)" : "var(--danger)"}>{u.status}</Badge></td>
                <td style={{ display: "flex", gap: 6 }}>
                  {isMissionAdmin && u.email && (u.status === "Pending Vetting" ? <button className="btn accent" onClick={() => onVet(u.id)}>Confirm Clearance</button> : <button className="btn ghost" onClick={() => onStatus(u.id, u.status === "Active" ? "Suspended" : "Active")}>{u.status === "Active" ? "Suspend" : "Reactivate"}</button>)}
                  {canDeleteUser(u) && <button className="btn ghost" style={{ color: "var(--danger)" }} onClick={() => handleDelete(u)}>Remove</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {isMissionAdmin && <button className="btn accent" style={{ marginTop: 12 }} onClick={() => setCreateFor({ role: "Custodian", missionId: null })}><Plus size={14} /> Add Custodian / Officer</button>}
        </div>
      )}

      {subTab === "GL Mapping" && (
        <div className="card">
          <h3><Landmark size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />GL / ERP Account Mapping <InfoTip title="GL / ERP Account Mapping">Maps each asset category to the corresponding account code in DIRCO's General Ledger / ERP system, so that acquisitions, transfers, and disposals post to the correct financial account automatically instead of needing manual journal entries.</InfoTip></h3>
          <div className="hint">Asset classification structure integrated with the General Ledger.</div>
          {glMapping.map(g => (<div className="row2" key={g.id} style={{ marginBottom: 6, alignItems: "center" }}><span style={{ fontSize: 13 }}>{g.category}</span><input value={g.glCode} onChange={e => onGlChange(g.id, e.target.value)} onBlur={e => onGlSave(g.id, e.target.value)} /></div>))}
        </div>
      )}

      {subTab === "Migration" && (
        <div className="card">
          <h3><Database size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />Legacy Data Migration <InfoTip title="Legacy Data Migration">When switching from an old asset system to this one, every record needs to move across without loss. This panel compares the legacy system's asset count and total value against what's actually landed in the new register — if the numbers don't match after migration, something was dropped or double-counted.</InfoTip></h3>
          <div className="hint">Migrate asset data from the current legacy system with a reconciliation check.</div>
          <div className="kv"><span>Legacy Asset Count</span><span>{migration.legacyCount}</span></div>
          <div className="kv"><span>Legacy Total Value</span><span>{fmtZAR(migration.legacyValue)}</span></div>
          {migration.status !== "idle" && (<><div className="kv"><span>Migrated Asset Count</span><span>{assets.length}</span></div><div className="kv"><span>Migrated Total Value</span><span>{fmtZAR(migratedValue)}</span></div></>)}
          {migration.status === "idle" && <button className="btn accent" onClick={onRunMigration}><RefreshCw size={14} /> Run Migration</button>}
          {migration.status === "running" && <Badge color="var(--warn)" icon={RefreshCw}>Migration running…</Badge>}
          {migration.status === "complete" && <Badge color="var(--ok)" icon={CheckCircle2}>Migration complete — reconciliation recorded</Badge>}
        </div>
      )}

      {subTab === "Project Plan" && (
        <div className="card">
          <h3><Milestone size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />Project Plan & Timeline <InfoTip title="Project Plan & Timeline">The implementation roadmap for this system — from initial configuration through to Go-Live at Head Office and all missions. Each milestone's status can be tracked as it progresses.</InfoTip></h3><div className="hint">Delivered immediately after contract award.</div>
          {milestones.map(m => (<div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px dashed var(--border)" }}>
            <span style={{ fontSize: 13 }}>{m.name} <span style={{ color: "var(--text-dim)" }}>· {m.date}</span></span>
            <select value={m.status} onChange={e => onSetMilestone(m.id, e.target.value)}><option>Not Started</option><option>In Progress</option><option>Complete</option></select></div>))}
        </div>
      )}

      {subTab === "Support Tickets" && (
        <div className="card">
          <h3><Ticket size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />Support Tickets <InfoTip title="Support Tickets">Day-to-day operational issues (scanner not pairing, a failed export, a mismatched asset found during verification) logged and tracked to resolution. <b>SLA</b> shows the agreed response time based on priority (High = 4h, Medium = 24h, Low = 72h).</InfoTip></h3><div className="hint">Joint maintenance & operations with DIRCO ICT / Transversal Systems Unit.</div>
          <div className="row2"><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Ticket subject" /><select value={priority} onChange={e => setPriority(e.target.value)}><option>Low</option><option>Medium</option><option>High</option></select></div>
          <button className="btn accent" style={{ marginTop: 8 }} onClick={raiseTicket}>Raise Ticket</button>
          <div style={{ marginTop: 10 }}>{tickets.map(t => (<div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dashed var(--border)", fontSize: 12.5 }}>
            <span>{t.subject} <span style={{ color: "var(--text-dim)" }}>· SLA {t.due}</span></span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}><Badge color={t.status === "Resolved" ? "var(--ok)" : t.status === "In Progress" ? "var(--warn)" : "var(--muted)"}>{t.status}</Badge>{t.status !== "Resolved" && <button className="btn ghost" onClick={() => onAdvanceTicket(t.id)}>Advance</button>}</span></div>))}</div>
        </div>
      )}

      {createFor && (
        <CreateUserModal
          onClose={() => setCreateFor(null)}
          onCreate={onCreateUser}
          authUser={authUser}
          missions={missions}
          presetRole={createFor.role}
          presetMissionId={createFor.missionId}
        />
      )}
    </>
  );
}

/* =====================================================================
   ASSET REGISTER
===================================================================== */
const CAN_EDIT_ROLES = ["System Owner", "Head Office Admin", "Mission Admin"];

function RowActionMenu({ asset, canEdit, onAction }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function handleScroll() { setOpen(false); }
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [open]);
  const isDisposed = asset.status === "Disposed";
  const items = [
    !isDisposed && canEdit && { key: "edit", label: "Edit Asset", icon: Edit3 },
    !isDisposed && { key: "transfer", label: "Transfer Asset", icon: ArrowRightLeft },
    !isDisposed && { key: "dispose", label: "Dispose", icon: TrendingDown },
    { key: "audit", label: "View Audit Trail", icon: FileSearch },
    { key: "transferHistory", label: "View Transfer History", icon: ClipboardList },
    !isDisposed && { key: "upload", label: "Upload Documents/Photos", icon: Camera },
  ].filter(Boolean);
  return (
    <span style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
      <button className="row-menu-btn" onClick={() => setOpen(o => !o)}><MoreVertical size={16} /></button>
      {open && (
        <>
          <div className="infotip-backdrop" onClick={() => setOpen(false)} />
          <div className="row-menu-panel">
            {items.map(it => (
              <div key={it.key} className="row-menu-item" onClick={() => { setOpen(false); onAction(it.key); }}>
                <it.icon size={13} /> {it.label}
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

function RegisterView({ assets, classes, missions, team, authUser, onAddAsset, onRequestAction, onRequestDisposal, onEditAsset, onAddPhoto, onAddDocument, onLoadDetail, initialStatusFilter }) {
  const [subTab, setSubTab] = useState(initialStatusFilter === "Disposed" ? "Disposed Assets" : "Active Assets");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter && initialStatusFilter !== "Disposed" ? initialStatusFilter : "All");
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState(null);
  const [initialMode, setInitialMode] = useState(null);
  const [disposeTarget, setDisposeTarget] = useState(null);
  const [dupWarning, setDupWarning] = useState(null);
  const [saving, setSaving] = useState(false);
  const canEdit = CAN_EDIT_ROLES.includes(authUser?.role);

  const scoped = useMemo(() => assets.filter(a => subTab === "Disposed Assets" ? a.status === "Disposed" : a.status !== "Disposed"), [assets, subTab]);
  const filtered = useMemo(() => scoped.filter(a => {
    const matchesQ = (a.desc + a.barcode + a.custodian + a.location + (a.serial || "")).toLowerCase().includes(query.toLowerCase());
    const matchesS = statusFilter === "All" || a.status === statusFilter;
    return matchesQ && matchesS;
  }), [scoped, query, statusFilter]);

  async function handleAdd(form) {
    setSaving(true);
    const res = await onAddAsset(form);
    setSaving(false);
    if (res?.duplicate) { setDupWarning(res.duplicate); return; }
    if (res?.ok) setShowAdd(false);
  }

  function openAsset(asset, mode) {
    setInitialMode(mode || null);
    setSelected(asset);
    onLoadDetail(asset.id); // fetches photos/documents/history in the background
  }

  function handleRowAction(asset, key) {
    if (key === "dispose") { setDisposeTarget(asset); return; }
    openAsset(asset, key);
  }

  const activeStatusOptions = ["All", "In Use", "Available", "Under Verification", "Missing", "Pending Disposal Approval"];

  return (
    <div className="card">
      <h3 style={{ marginBottom: 12 }}>Asset Register <InfoTip title="Asset Register">This is the Fixed Asset Register (FAR) — the single source of truth for every asset DIRCO owns, and the primary working screen for everything that happens to an asset.
        <ul>
          <li><b>Active Assets</b>: everything still in service (In Use, Available, Under Verification, Missing, Pending Disposal)</li>
          <li><b>Disposed Assets</b>: sold, scrapped, donated, or written off — kept for audit, read-only</li>
        </ul>
        Use the <b>⋮</b> menu on any row for quick actions, or click the row for full details.</InfoTip></h3>
      <Tabs tabs={["Active Assets", "Disposed Assets"]} active={subTab} onChange={setSubTab} />
      <div className="toolbar" style={{ marginTop: 12 }}>
        <div className="search"><Search size={15} color="var(--text-dim)" /><input placeholder="Search barcode, serial number, description, custodian, location…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        {subTab === "Active Assets" && <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>{activeStatusOptions.map(s => <option key={s}>{s}</option>)}</select>}
        {subTab === "Active Assets" && <div style={{ marginLeft: "auto" }}><button className="btn" onClick={() => setShowAdd(true)}><Plus size={15} /> Capture Asset</button></div>}
      </div>
      <table>
        <thead><tr><th>Barcode</th><th>Description</th><th>Category</th><th>Location</th><th>Custodian</th><th>Value</th><th>Status</th><th /></tr></thead>
        <tbody>
          {filtered.map(a => {
            const meta = statusMeta[a.status];
            return (
              <tr className="row" key={a.id} onClick={() => openAsset(a, null)}>
                <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{a.barcode}</td>
                <td>{a.desc}</td><td>{a.category}</td>
                <td><span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-dim)" }}><MapPin size={12} />{a.location || "Unassigned"}</span></td>
                <td>{a.custodian}</td><td>{fmtZAR(a.price)}</td>
                <td><Badge color={meta.color} icon={meta.icon}>{a.status}</Badge></td>
                <td><RowActionMenu asset={a} canEdit={canEdit} onAction={key => handleRowAction(a, key)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No assets match your filters.</div>}

      {showAdd && <AddAssetModal onClose={() => setShowAdd(false)} onSave={handleAdd} classes={classes} missions={missions} team={team} authUser={authUser} saving={saving} />}
      {dupWarning && (
        <Modal onClose={() => setDupWarning(null)} width={420}>
          <div style={{ display: "flex", gap: 10 }}><AlertTriangle color="var(--danger)" />
            <div>
              <h2 style={{ marginTop: 0 }}>Possible duplicate asset</h2>
              <p style={{ fontSize: 13, color: "var(--text-dim)" }}>An asset with a matching barcode or serial number already exists: <b>{dupWarning.desc}</b> ({dupWarning.barcode}). Capture was blocked to keep the FAR as a single source of truth. Use Bulk Data → Duplicate Detection to merge records if required.</p>
              <button className="btn" onClick={() => setDupWarning(null)}>Understood</button>
            </div>
          </div>
        </Modal>
      )}
      {selected && <AssetDetailModal asset={assets.find(a => a.id === selected.id) || selected} classes={classes} missions={missions} team={team} authUser={authUser} initialMode={initialMode} onClose={() => { setSelected(null); setInitialMode(null); }} onRequestAction={onRequestAction} onRequestDisposal={onRequestDisposal} onEditAsset={onEditAsset} onPhoto={onAddPhoto} onDocument={onAddDocument} />}
      {disposeTarget && <DisposalModal asset={disposeTarget} assets={[disposeTarget]} onClose={() => setDisposeTarget(null)} onSubmit={(id, data) => { onRequestDisposal(id, data); setDisposeTarget(null); }} />}
    </div>
  );
}

function AssetDetailModal({ asset, classes, missions, team, authUser, initialMode, onClose, onRequestAction, onRequestDisposal, onEditAsset, onPhoto, onDocument }) {
  const [mode, setMode] = useState(["transfer", "reclassify", "edit"].includes(initialMode) ? initialMode : null);
  const [historyTab, setHistoryTab] = useState(initialMode === "transferHistory" ? "Transfer History" : "Audit Trail");
  const [form, setForm] = useState({ newLocation: asset.location || missions[0]?.name || "", newCustodian: asset.custodian, newRoom: asset.room, newCategory: asset.category, note: "" });
  const [editForm, setEditForm] = useState({ desc: asset.desc, serial: asset.serial, room: asset.room, costCentre: asset.costCentre, poNumber: asset.poNumber, invoiceRef: asset.invoiceRef, note: "" });
  const [submittedMsg, setSubmittedMsg] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [showDispose, setShowDispose] = useState(false);
  const photoRef = useRef(null); const docRef = useRef(null);
  const meta = statusMeta[asset.status];
  const dep = computeDepreciation(asset, classes);
  const isUnassigned = !asset.location;
  const isDisposed = asset.status === "Disposed";
  const canOffboard = asset.status === "In Use" && !isUnassigned;
  const canEdit = CAN_EDIT_ROLES.includes(authUser?.role);
  const photos = asset.photos || [];
  const documents = asset.documents || [];
  const history = asset.history || [];
  const custodiansInMission = (team || []).filter(u => u.role === "Custodian" && u.missionName === form.newLocation);

  useEffect(() => { if (initialMode === "upload") photoRef.current?.click(); }, []);

  async function submitTransfer() {
    const res = await onRequestAction(asset.id, "Transfer", { newLocation: form.newLocation, newCustodian: form.newCustodian, newRoom: form.newRoom }, form.note || (isUnassigned ? `Assigned to ${form.newLocation}` : `Moved to ${form.newLocation}`));
    setMode(null);
    if (res?.ok) setSubmittedMsg(isUnassigned ? "Assignment submitted — awaiting approval." : "Transfer submitted — awaiting approval.");
  }
  async function submitReclass() {
    const res = await onRequestAction(asset.id, "Reclassification", { newCategory: form.newCategory }, form.note || `Reclassified to ${form.newCategory}`);
    setMode(null);
    if (res?.ok) setSubmittedMsg("Reclassification submitted — awaiting approval.");
  }
  async function submitOffboard() {
    const res = await onRequestAction(asset.id, "Transfer", { offboard: true }, form.note || `Offboarded from ${asset.custodian} at ${asset.location}`);
    setMode(null);
    if (res?.ok) setSubmittedMsg("Return to store submitted — awaiting approval.");
  }
  async function submitEdit() {
    const { note, ...fields } = editForm;
    const res = await onEditAsset(asset.id, fields, note || "Details corrected");
    setMode(null);
    if (res?.ok) setSubmittedMsg("Asset details updated.");
  }
  function handlePhoto(e) { const file = e.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = ev => onPhoto(asset.id, ev.target.result); reader.readAsDataURL(file); }
  function handleDoc(e) { const file = e.target.files?.[0]; if (!file) return; onDocument(asset.id, file.name); }

  const transferHistory = history.filter(h => h.type === "Transfer");

  return (
    <Modal onClose={onClose} width={640}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div><h2 style={{ margin: 0 }}>{asset.desc}</h2><div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "ui-monospace, monospace" }}>{asset.barcode} · {asset.id.slice(0, 8)}</div></div>
        <X size={18} style={{ cursor: "pointer" }} onClick={onClose} />
      </div>
      <div style={{ margin: "12px 0", display: "flex", gap: 8, alignItems: "center" }}>
        <Badge color={meta.color} icon={meta.icon}>{asset.status}</Badge>
        {isDisposed && <Badge color="var(--muted)">Read-only — disposed assets can't be edited</Badge>}
        {submittedMsg && <Badge color="var(--warn)" icon={ClipboardList}>{submittedMsg}</Badge>}
      </div>
      <div className="detail-panel">
        <div className="kv"><span>Category</span><span>{asset.category}</span></div>
        <div className="kv"><span>Location</span><span>{isUnassigned ? <Badge color="var(--secondary)">Unassigned — available stock</Badge> : `${asset.location} — ${asset.room}`}</span></div>
        <div className="kv"><span>Custodian</span><span>{asset.custodian || "— none assigned —"}</span></div>
        <div className="kv"><span>Cost Centre <InfoTip title="Cost Centre">The internal budget/department code responsible for this asset — used for financial reporting and allocating costs.</InfoTip></span><span>{asset.costCentre}</span></div>
        <div className="kv"><span>Serial Number</span><span>{asset.serial}</span></div>
        <div className="kv"><span>Purchase Date</span><span>{asset.purchaseDate}</span></div>
        <div className="kv"><span>Purchase Price</span><span>{fmtZAR(asset.price)}</span></div>
        <div className="kv"><span>Carrying Value <InfoTip title="Carrying Value">What the asset is worth <b>today</b>, after subtracting accumulated depreciation from its purchase price. Formula: Purchase Price − Accumulated Depreciation, using the useful life configured for this asset's classification on the GRAP Classification screen.</InfoTip></span><span>{fmtZAR(dep.carrying)}</span></div>
        <div className="kv"><span>Purchase Order Number</span><span>{asset.poNumber || "—"}</span></div>
        <div className="kv"><span>Invoice Reference</span><span>{asset.invoiceRef || "—"}</span></div>
        <div className="kv"><span>Funding Source <InfoTip title="Funding Source">Where the money for this asset came from — Voted Funds (the department's own budget), Donor Funding, Own Revenue, or a Donation. Required for SCOA and Treasury reporting.</InfoTip></span><span>{asset.fundingSource}</span></div>
        <div className="kv"><span>SCOA Fund / Item <InfoTip title="SCOA Fund / Item">SCOA (Standard Chart of Accounts) segments required by National Treasury. <b>Fund</b> identifies the budget vote; <b>Item</b> identifies the specific expenditure classification (e.g. "Computer Equipment"). Every asset must have these to be reported correctly.</InfoTip></span><span>{asset.scoa.fund} / {asset.scoa.item}</span></div>
      </div>

      {mode === "edit" && (
        <div className="inline-form">
          <h3>Edit Asset <InfoTip title="Direct Edit">Corrects basic descriptive details immediately, no approval needed. To change location/custodian, category, or value, use Transfer/Reclassify/Fair Valuation instead — those go through approval.</InfoTip></h3>
          <div className="row2">
            <Field label="Description"><input value={editForm.desc} onChange={e => setEditForm({ ...editForm, desc: e.target.value })} /></Field>
            <Field label="Serial Number"><input value={editForm.serial} onChange={e => setEditForm({ ...editForm, serial: e.target.value })} /></Field>
          </div>
          <div className="row2">
            <Field label="Room / Floor"><input value={editForm.room} onChange={e => setEditForm({ ...editForm, room: e.target.value })} /></Field>
            <Field label="Cost Centre"><input value={editForm.costCentre} onChange={e => setEditForm({ ...editForm, costCentre: e.target.value })} /></Field>
          </div>
          <div className="row2">
            <Field label="PO Number"><input value={editForm.poNumber} onChange={e => setEditForm({ ...editForm, poNumber: e.target.value })} /></Field>
            <Field label="Invoice Reference"><input value={editForm.invoiceRef} onChange={e => setEditForm({ ...editForm, invoiceRef: e.target.value })} /></Field>
          </div>
          <Field label="Note"><input value={editForm.note} onChange={e => setEditForm({ ...editForm, note: e.target.value })} placeholder="What was corrected and why" /></Field>
          <div style={{ display: "flex", gap: 8 }}><button className="btn accent" onClick={submitEdit}>Save Changes</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
        </div>
      )}
      {mode === "transfer" && (
        <div className="inline-form">
          <h3>{isUnassigned ? "Assign to Mission & Custodian" : "Record Transfer"} <InfoTip title="Requires Approval">This submits a request — the change only takes effect once approved on the Approvals screen. Moving an asset to a different mission (including Head Office) always needs Head Office Admin or System Owner sign-off. Staying within the same mission can be approved by that mission's admin.</InfoTip></h3>
          <div className="row2">
            <Field label={isUnassigned ? "Assign to Mission" : "New Location"}><select value={form.newLocation} onChange={e => setForm({ ...form, newLocation: e.target.value })}>{missions.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></Field>
            <Field label="New Room / Floor"><input value={form.newRoom} onChange={e => setForm({ ...form, newRoom: e.target.value })} /></Field>
          </div>
          <Field label={isUnassigned ? "Assign to Custodian" : "New Custodian"}>
            <select value={form.newCustodian || ""} onChange={e => setForm({ ...form, newCustodian: e.target.value })}>
              <option value="">— None / Unassigned —</option>
              {custodiansInMission.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            {custodiansInMission.length === 0 && <div className="hint" style={{ margin: "4px 0 0" }}>No custodians registered for {form.newLocation} yet — add one under Configuration.</div>}
          </Field>
          <Field label="Reason"><input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder={isUnassigned ? "e.g. Issued for new starter" : "Reason for transfer"} /></Field>
          <div style={{ display: "flex", gap: 8 }}><button className="btn accent" onClick={submitTransfer}>Submit for Approval</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
        </div>
      )}
      {mode === "reclassify" && (
        <div className="inline-form">
          <h3>Reclassify Asset <InfoTip title="Requires Approval">This submits a request — the change only takes effect once approved on the Approvals screen.</InfoTip></h3>
          <Field label="New Category"><select value={form.newCategory} onChange={e => setForm({ ...form, newCategory: e.target.value })}>{(classes?.length ? classes.filter(c => c.active).map(c => c.name) : CATEGORIES).map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Reason"><input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="Reason for reclassification" /></Field>
          <div style={{ display: "flex", gap: 8 }}><button className="btn accent" onClick={submitReclass}>Submit for Approval</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
        </div>
      )}
      {mode === "offboard" && (
        <div className="inline-form">
          <h3>Return to Store <InfoTip title="Offboarding">Clears the custodian and mission assignment and returns this asset to "Available" status once approved — use this when someone leaves, or equipment is handed back in.</InfoTip></h3>
          <div className="hint">This will clear the custodian ({asset.custodian}) and location ({asset.location}), making the asset available for reassignment.</div>
          <Field label="Reason"><input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="e.g. Staff member offboarded" /></Field>
          <div style={{ display: "flex", gap: 8 }}><button className="btn accent" onClick={submitOffboard}>Submit for Approval</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
        </div>
      )}

      {photos.length > 0 && (<div style={{ marginTop: 12 }}><div className="section-title">Photos ({photos.length}) <span style={{ fontWeight: 400, textTransform: "none" }}>— click to enlarge</span></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{photos.map((p, i) => <img key={i} src={p} onClick={() => setLightbox(p)} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", cursor: "zoom-in" }} />)}</div></div>)}
      {documents.length > 0 && (<div style={{ marginTop: 12 }}><div className="section-title">Documents ({documents.length})</div>
        {documents.map(d => <div key={d.id} style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center", padding: "4px 0" }}><Paperclip size={12} />{d.name}<span style={{ color: "var(--text-dim)" }}>· {d.ts}</span></div>)}</div>)}

      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="section-title" style={{ marginBottom: 0 }}>History</div>
          <button className="btn ghost" onClick={() => {
            const rows = historyTab === "Audit Trail" ? history : transferHistory;
            const header = "Type,Actor,Note,Timestamp\n";
            const body = rows.map(h => [h.type, h.actor || "System", h.note, h.ts].map(v => `"${(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
            downloadText(`${asset.barcode}_${historyTab.replace(/\s/g, "_").toLowerCase()}.csv`, header + body + "\n");
          }}><Download size={12} /> Export</button>
        </div>
        <Tabs tabs={["Audit Trail", "Transfer History"]} active={historyTab} onChange={setHistoryTab} />
        {historyTab === "Audit Trail" && (history.length > 0 ? history.map(h => <div key={h.id} style={{ fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed var(--border)" }}><b>{h.type}</b> by {h.actor || "System"} — {h.note} <span style={{ color: "var(--text-dim)" }}>· {h.ts}</span></div>) : <div className="hint">No history yet.</div>)}
        {historyTab === "Transfer History" && (transferHistory.length > 0 ? transferHistory.map(h => <div key={h.id} style={{ fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed var(--border)" }}>by {h.actor || "System"} — {h.note} <span style={{ color: "var(--text-dim)" }}>· {h.ts}</span></div>) : <div className="hint">No transfers yet.</div>)}
      </div>

      {!isDisposed && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {canEdit && <button className="btn ghost" onClick={() => setMode("edit")}><Edit3 size={14} /> Edit Asset</button>}
          <button className="btn accent" onClick={() => setMode("transfer")}><ArrowRightLeft size={14} /> {isUnassigned ? "Assign to Mission & Custodian" : "Transfer"}</button>
          <button className="btn ghost" onClick={() => setMode("reclassify")}><Layers size={14} /> Reclassify</button>
          {canOffboard && <button className="btn ghost" onClick={() => setMode("offboard")}><PackageOpen size={14} /> Return to Store</button>}
          {(asset.status === "In Use" || asset.status === "Available") && <button className="btn ghost" onClick={() => setShowDispose(true)}><TrendingDown size={14} /> Dispose</button>}
          <button className="btn ghost" onClick={() => photoRef.current?.click()}><Camera size={14} /> Add Photo</button>
          <button className="btn ghost" onClick={() => docRef.current?.click()}><Paperclip size={14} /> Attach Document</button>
        </div>
      )}
      <input ref={photoRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handlePhoto} />
      <input ref={docRef} type="file" style={{ display: "none" }} onChange={handleDoc} />

      {lightbox && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <img src={lightbox} className="lightbox-img" />
          <X size={22} color="#fff" style={{ position: "absolute", top: 20, right: 24, cursor: "pointer" }} onClick={() => setLightbox(null)} />
        </div>
      )}
      {showDispose && (
        <DisposalModal asset={asset} assets={[asset]} onClose={() => setShowDispose(false)} onSubmit={(id, data) => { onRequestDisposal(id, data); setShowDispose(false); }} />
      )}
    </Modal>
  );
}

function AddAssetModal({ onClose, onSave, classes, missions, team, authUser, saving, mode }) {
  const missionScoped = authUser && !["System Owner", "Head Office Admin"].includes(authUser.role);
  const [form, setForm] = useState({ barcode: "", desc: "", category: CATEGORIES[0], location: missionScoped ? (authUser.missionName || "") : (missions[0]?.name || ""), room: "", custodian: "", purchaseDate: "", price: "", costCentre: "", serial: "", poNumber: "", invoiceRef: "", currency: "ZAR", fundingSource: FUNDING_SOURCES[0], scoa: { fund: "Vote 06", func: "International Relations", item: "" } });
  const [error, setError] = useState("");
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setScoa = k => e => setForm(f => ({ ...f, scoa: { ...f.scoa, [k]: e.target.value } }));
  const isAcquisition = mode === "acquisition";
  const custodiansInMission = (team || []).filter(u => u.role === "Custodian" && u.missionName === form.location);

  function submit() {
    if (!form.barcode || !form.desc) { setError("Barcode and description are required."); return; }
    if (isAcquisition && (!form.poNumber || !form.invoiceRef)) { setError("Purchase Order number and Invoice reference are required to record an acquisition."); return; }
    if (!form.scoa.item) { setError("SCOA Item segment is required before the asset can be capitalised."); return; }
    setError(""); onSave({ ...form, price: Number(form.price) || 0 });
  }

  const classOptions = classes.length ? classes.filter(c => c.active).map(c => c.name) : CATEGORIES;

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2>{isAcquisition ? "Record Asset Acquisition" : "Capture New Asset"}</h2><X size={18} style={{ cursor: "pointer" }} onClick={onClose} /></div>
      <div className="hint" style={{ marginBottom: 14 }}>{isAcquisition ? "Capturing the PO and invoice reference here automatically creates the FAR entry for this asset." : "Fields align to the Fixed Asset Register schema (TOR §4.1) plus SCOA segments."}</div>
      {error && <div className="error-banner">{error}</div>}
      <div className="row2">
        <Field label="Barcode"><input value={form.barcode} onChange={set("barcode")} placeholder="DIRCO-00xxxxx" /></Field>
        <Field label="Serial Number"><input value={form.serial} onChange={set("serial")} /></Field>
      </div>
      <Field label="Description"><input value={form.desc} onChange={set("desc")} placeholder="e.g. Dell Latitude 5440 Laptop" /></Field>
      <div className="row2">
        <Field label="Category"><select value={form.category} onChange={set("category")}>{classOptions.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Location / Mission">
          {missionScoped ? (
            <input value={form.location} disabled style={{ background: "#F4F6F9" }} />
          ) : (
            <select value={form.location} onChange={set("location")}>
              <option value="">— Unassigned (available stock) —</option>
              {missions.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
            </select>
          )}
        </Field>
      </div>
      <div className="row2">
        <Field label="Room / Floor"><input value={form.room} onChange={set("room")} placeholder="e.g. 3rd Floor, Rm 312" /></Field>
        <Field label="Custodian">
          <select value={form.custodian} onChange={set("custodian")}>
            <option value="">— None / Unassigned —</option>
            {custodiansInMission.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="row2">
        <Field label={"Purchase Order Number" + (isAcquisition ? " *" : "")}><input value={form.poNumber} onChange={set("poNumber")} placeholder="e.g. PO-2026-0142" /></Field>
        <Field label={"Invoice Reference" + (isAcquisition ? " *" : "")}><input value={form.invoiceRef} onChange={set("invoiceRef")} placeholder="e.g. INV-88231" /></Field>
      </div>
      <div className="row2">
        <Field label="Cost Centre"><input value={form.costCentre} onChange={set("costCentre")} /></Field>
        <Field label="Funding Source"><select value={form.fundingSource} onChange={set("fundingSource")}>{FUNDING_SOURCES.map(f => <option key={f}>{f}</option>)}</select></Field>
      </div>
      <div className="row2">
        <Field label="Purchase Date"><input type="date" value={form.purchaseDate} onChange={set("purchaseDate")} /></Field>
        <Field label="Purchase Price (ZAR)"><input type="number" value={form.price} onChange={set("price")} /></Field>
      </div>
      <div className="section-title">SCOA Segments (National Treasury)</div>
      <div className="row2">
        <Field label="Fund"><input value={form.scoa.fund} onChange={setScoa("fund")} /></Field>
        <Field label="Function"><input value={form.scoa.func} onChange={setScoa("func")} /></Field>
        <Field label="Item *"><input value={form.scoa.item} onChange={setScoa("item")} placeholder="e.g. Computer Equipment" /></Field>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn accent" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save Asset"}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/* =====================================================================
   DEPRECIATION & DISPOSALS
===================================================================== */
function DepreciationView({ assets, classes, missions, team, authUser, onAddAsset, onRequestAction }) {
  const [lastRun, setLastRun] = useState(null);
  const [valuateAsset, setValuateAsset] = useState(null);
  const [showAcquire, setShowAcquire] = useState(false);
  const [dupWarning, setDupWarning] = useState(null);
  const [saving, setSaving] = useState(false);

  const rows = assets.filter(a => a.status !== "Disposed").map(a => ({ ...a, dep: computeDepreciation(a, classes) }));
  const zeroValueInUse = assets.filter(a => a.price === 0 && a.status === "In Use");
  const acquisitions = [...assets].filter(a => a.poNumber).sort((a, b) => (b.purchaseDate || "").localeCompare(a.purchaseDate || ""));

  function runDepreciation() { setLastRun(nowStamp()); }

  async function handleAcquire(form) {
    setSaving(true);
    const res = await onAddAsset(form);
    setSaving(false);
    if (res?.duplicate) { setDupWarning(res.duplicate); return; }
    if (res?.ok) setShowAcquire(false);
  }

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><h3>Asset Acquisitions <InfoTip title="Asset Acquisitions">Recording an acquisition against a <b>Purchase Order (PO)</b> and <b>Invoice Reference</b> is how a new asset gets legally capitalised into the FAR. The same PO number can cover several assets (e.g. one PO for 10 laptops), but the same PO + specific asset combination can't be captured twice — that's checked automatically against barcode/serial.</InfoTip></h3><div className="hint">Capture purchase order, invoice reference and cost. Approved acquisitions automatically create the FAR entry, and the same PO/asset combination cannot be captured twice.</div></div>
          <button className="btn accent" onClick={() => setShowAcquire(true)}><Plus size={14} /> Record New Acquisition</button>
        </div>
        <table>
          <thead><tr><th>Asset</th><th>PO Number</th><th>Invoice Ref</th><th>Purchase Date</th><th>Cost</th><th>FAR Status</th></tr></thead>
          <tbody>{acquisitions.map(a => (
            <tr key={a.id}>
              <td>{a.desc}</td>
              <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{a.poNumber}</td>
              <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{a.invoiceRef || "—"}</td>
              <td>{a.purchaseDate}</td>
              <td>{fmtZAR(a.price)}</td>
              <td><Badge color="var(--ok)" icon={CheckCircle2}>Capitalised in FAR</Badge></td>
            </tr>
          ))}</tbody>
        </table>
        {acquisitions.length === 0 && <div className="hint">No acquisitions recorded yet — click "Record New Acquisition" to capture one against a PO.</div>}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><h3>Annual Depreciation <InfoTip title="Annual Depreciation"><b>Depreciation</b> spreads an asset's cost over its useful life, so the register reflects real value rather than original price forever.
            <ul>
              <li><b>Useful Life</b>: how many years the asset is expected to last — configurable per classification on the GRAP Classification screen</li>
              <li><b>Accumulated</b>: total depreciation charged so far (Purchase Price ÷ Useful Life × years elapsed, capped at the purchase price)</li>
              <li><b>Carrying Value</b>: what's left — Purchase Price − Accumulated</li>
            </ul>
            This uses the straight-line method (equal amounts each year).</InfoTip></h3><div className="hint">Straight-line, calculated to individual fixed-asset level. {lastRun && `Last run: ${lastRun}`}</div></div>
          <button className="btn accent" onClick={runDepreciation}><RefreshCw size={14} /> Run Annual Depreciation</button>
        </div>
        <table>
          <thead><tr><th>Asset</th><th>Category</th><th>Useful Life</th><th>Cost</th><th>Accumulated</th><th>Carrying Value</th></tr></thead>
          <tbody>{rows.map(a => (<tr key={a.id}><td>{a.desc}</td><td>{a.category}</td><td>{a.dep.life} yrs</td><td>{fmtZAR(a.price)}</td><td>{fmtZAR(a.dep.accumulated)}</td><td style={{ fontWeight: 700 }}>{fmtZAR(a.dep.carrying)}</td></tr>))}</tbody>
        </table>
      </div>
      <div className="card">
        <h3>Fair Valuation — Zero-Value Assets In Use <InfoTip title="Fair Valuation">Some older assets have no recorded purchase price (often because they were fully depreciated long ago, donated, or migrated from a legacy system without a value) but are still actively used. GRAP requires these to be given a realistic assessed value — this panel lets an officer set one with a documented justification, which is logged to the asset's history for audit purposes. This submits a request that requires approval, same as Transfer/Reclassify.</InfoTip></h3><div className="hint">Assets with no recorded value that remain in service.</div>
        {zeroValueInUse.length === 0 && <div className="hint">No zero-value assets in use.</div>}
        {zeroValueInUse.map(a => (<div key={a.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px dashed var(--border)" }}><span>{a.desc}</span><button className="btn ghost" onClick={() => setValuateAsset(a)}>Apply Fair Value</button></div>))}
      </div>
      <div className="card" style={{ background: "#FAFBFD" }}>
        <h3>Looking for Disposals? <InfoTip title="Disposal moved">Disposal is now initiated directly from the Asset Register's row action menu (⋮) — select an asset, choose "Dispose", and it's submitted for approval from there. This keeps the Register as the single working screen for everything that happens to an asset.</InfoTip></h3>
        <div className="hint">Go to Asset Register → open the ⋮ menu on any active asset → Dispose. Pending and reviewed disposal requests are visible on the Approvals screen.</div>
      </div>
      {valuateAsset && <FairValueModal asset={valuateAsset} onClose={() => setValuateAsset(null)} onSubmit={(id, v, j) => { onRequestAction(id, "Fair Valuation", { value: Number(v) }, j); setValuateAsset(null); }} />}
      {showAcquire && <AddAssetModal onClose={() => setShowAcquire(false)} onSave={handleAcquire} classes={classes} missions={missions} team={team} authUser={authUser} saving={saving} mode="acquisition" />}
      {dupWarning && (
        <Modal onClose={() => setDupWarning(null)} width={420}>
          <div style={{ display: "flex", gap: 10 }}><AlertTriangle color="var(--danger)" />
            <div>
              <h2 style={{ marginTop: 0 }}>Duplicate PO/asset combination</h2>
              <p style={{ fontSize: 13, color: "var(--text-dim)" }}>An asset with a matching barcode or serial number already exists: <b>{dupWarning.desc}</b> ({dupWarning.barcode}). This acquisition was blocked so the same PO/asset combination isn't capitalised twice.</p>
              <button className="btn" onClick={() => setDupWarning(null)}>Understood</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
function DisposalModal({ asset, assets, onClose, onSubmit }) {
  const [assetId, setAssetId] = useState(asset?.id || assets[0]?.id);
  const [method, setMethod] = useState("Sale"); const [reason, setReason] = useState(""); const [value, setValue] = useState("");
  return (
    <Modal onClose={onClose} width={480}>
      <h2>New Disposal Request</h2>
      <Field label="Asset"><select value={assetId} onChange={e => setAssetId(e.target.value)}>{assets.map(a => <option key={a.id} value={a.id}>{a.desc} ({a.barcode})</option>)}</select></Field>
      <Field label="Method"><select value={method} onChange={e => setMethod(e.target.value)}>{["Sale", "Scrap", "Donation", "Write-off"].map(m => <option key={m}>{m}</option>)}</select></Field>
      <Field label="Reason"><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. beyond economical repair" /></Field>
      <Field label="Estimated Disposal Value (ZAR)"><input type="number" value={value} onChange={e => setValue(e.target.value)} /></Field>
      <div style={{ display: "flex", gap: 8 }}><button className="btn accent" onClick={() => onSubmit(assetId, { method, reason, value: Number(value) || 0 })}>Submit for Approval</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
function FairValueModal({ asset, onClose, onSubmit }) {
  const [value, setValue] = useState(""); const [justification, setJustification] = useState("");
  return (
    <Modal onClose={onClose} width={440}>
      <h2>Request Fair Value</h2><div className="hint">{asset.desc} — this will be reviewed by an administrator before it takes effect.</div>
      <Field label="New Assessed Value (ZAR)"><input type="number" value={value} onChange={e => setValue(e.target.value)} /></Field>
      <Field label="Justification"><input value={justification} onChange={e => setJustification(e.target.value)} placeholder="Basis for valuation" /></Field>
      <div style={{ display: "flex", gap: 8 }}><button className="btn accent" onClick={() => onSubmit(asset.id, value, justification)} disabled={!value || !justification}>Submit for Approval</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

/* =====================================================================
   WIP PROJECTS
===================================================================== */
function WipView({ wip, onAddInvoice, onAddRetention, onAddCession, onAddBoq, onCapitalise }) {
  const [openId, setOpenId] = useState(null);
  const project = wip.find(p => p.id === openId);
  function spent(p) { return p.invoices.reduce((s, i) => s + i.amount, 0); }

  return (
    <div className="card">
      <h3>WIP Project Register <InfoTip title="Work-in-Progress (WIP) Projects">A <b>WIP project</b> is a capital project (e.g. a building refurbishment) that's still being built or paid for — its costs sit outside the normal asset register until it's finished.
        <ul>
          <li><b>Invoices</b>: payments made against the project, reconciled to the GL</li>
          <li><b>Retentions</b>: a % of payment withheld from the contractor until the work is confirmed complete (secured by a "surety" guarantee)</li>
          <li><b>Cessions</b>: payments legally redirected to a third-party financier</li>
          <li><b>BOQ (Bill of Quantities)</b>: a breakdown of exactly what the invoiced money was spent on</li>
          <li><b>Capitalise</b>: once complete, the project is "unbundled" into individual fixed assets and moved into the main register</li>
        </ul>
      </InfoTip></h3>
      <div className="hint">Track allocations, invoices, retentions, cessions, BOQ breakdown and capitalisation readiness.</div>
      <table>
        <thead><tr><th>Project</th><th>Budget</th><th>Spent to Date</th><th>% Complete</th><th>Status</th><th /></tr></thead>
        <tbody>
          {wip.map(p => {
            const sp = spent(p); const pct = p.budget ? Math.min(100, Math.round(sp / p.budget * 100)) : 0;
            return (
              <tr key={p.id} className="row" onClick={() => setOpenId(p.id)}>
                <td>{p.name}</td><td>{fmtZAR(p.budget)}</td><td>{fmtZAR(sp)}</td>
                <td style={{ width: 160 }}><ProgressBar pct={pct} /></td>
                <td><Badge color={p.status === "Capitalised" ? "var(--muted)" : p.status === "Ready to Capitalise" ? "var(--ok)" : "var(--warn)"}>{p.status}</Badge></td>
                <td><ChevronRight size={15} color="var(--text-dim)" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {wip.length === 0 && <div className="hint">No WIP projects yet.</div>}
      {project && <WipDetailModal project={project} spentTotal={spent(project)} onClose={() => setOpenId(null)} onAddInvoice={onAddInvoice} onAddRetention={onAddRetention} onAddCession={onAddCession} onAddBoq={onAddBoq} onCapitalise={onCapitalise} />}
    </div>
  );
}
function WipDetailModal({ project, spentTotal, onClose, onAddInvoice, onAddRetention, onAddCession, onAddBoq, onCapitalise }) {
  const [tab, setTab] = useState("Invoices");
  const [invRef, setInvRef] = useState(""); const [invAmt, setInvAmt] = useState("");
  const [retPct, setRetPct] = useState(""); const [retSurety, setRetSurety] = useState("");
  const [cesBen, setCesBen] = useState(""); const [cesAmt, setCesAmt] = useState("");
  const [boqItem, setBoqItem] = useState(""); const [boqAmt, setBoqAmt] = useState("");
  const [capLines, setCapLines] = useState([{ desc: project.name + " — Component 1", value: project.budget }]);
  const boqTotal = project.boq.reduce((s, b) => s + b.amount, 0);
  const capTotal = capLines.reduce((s, l) => s + (Number(l.value) || 0), 0);

  return (
    <Modal onClose={onClose} width={680}>
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>{project.name}</h2><X size={18} style={{ cursor: "pointer" }} onClick={onClose} /></div>
      <div className="hint">Budget {fmtZAR(project.budget)} · Spent {fmtZAR(spentTotal)} · Status {project.status}</div>
      <Tabs tabs={["Invoices", "Retentions & Sureties", "Cessions", "BOQ Breakdown", "Capitalise"]} active={tab} onChange={setTab} />
      {tab === "Invoices" && (
        <div className="inline-form">
          {project.invoices.map(i => <div key={i.id} className="kv"><span>{i.ref}</span><span>{fmtZAR(i.amount)}</span></div>)}
          <div className="row2" style={{ marginTop: 10 }}><Field label="Invoice Ref"><input value={invRef} onChange={e => setInvRef(e.target.value)} /></Field><Field label="Amount (ZAR)"><input type="number" value={invAmt} onChange={e => setInvAmt(e.target.value)} /></Field></div>
          <button className="btn accent" onClick={() => { onAddInvoice(project.id, invRef, invAmt); setInvRef(""); setInvAmt(""); }} disabled={!invRef || !invAmt}>Record Invoice & Reconcile to GL</button>
        </div>
      )}
      {tab === "Retentions & Sureties" && (
        <div className="inline-form">
          {project.retentions.map(r => <div key={r.id} className="kv"><span>{r.pct}% retention</span><span>{r.surety}</span></div>)}
          {project.retentions.length === 0 && <div className="hint">No retentions captured.</div>}
          <div className="row2" style={{ marginTop: 10 }}><Field label="Retention %"><input type="number" value={retPct} onChange={e => setRetPct(e.target.value)} /></Field><Field label="Surety Reference"><input value={retSurety} onChange={e => setRetSurety(e.target.value)} /></Field></div>
          <button className="btn accent" onClick={() => { onAddRetention(project.id, retPct, retSurety); setRetPct(""); setRetSurety(""); }} disabled={!retPct || !retSurety}>Add Retention</button>
        </div>
      )}
      {tab === "Cessions" && (
        <div className="inline-form">
          {project.cessions.map(c => <div key={c.id} className="kv"><span>{c.beneficiary}</span><span>{fmtZAR(c.amount)}</span></div>)}
          {project.cessions.length === 0 && <div className="hint">No cessions captured.</div>}
          <div className="row2" style={{ marginTop: 10 }}><Field label="Beneficiary"><input value={cesBen} onChange={e => setCesBen(e.target.value)} /></Field><Field label="Amount (ZAR)"><input type="number" value={cesAmt} onChange={e => setCesAmt(e.target.value)} /></Field></div>
          <button className="btn accent" onClick={() => { onAddCession(project.id, cesBen, cesAmt); setCesBen(""); setCesAmt(""); }} disabled={!cesBen || !cesAmt}>Record Cession Payment</button>
        </div>
      )}
      {tab === "BOQ Breakdown" && (
        <div className="inline-form">
          {project.boq.map(b => <div key={b.id} className="kv"><span>{b.item}</span><span>{fmtZAR(b.amount)}</span></div>)}
          <div className="kv" style={{ fontWeight: 700 }}><span>BOQ Total</span><span>{fmtZAR(boqTotal)}</span></div>
          <div className="hint">{boqTotal === project.invoices.reduce((s, i) => s + i.amount, 0) ? "✓ BOQ reconciles to invoiced total." : "⚠ BOQ total does not yet match invoiced total — continue breaking down invoices."}</div>
          <div className="row2" style={{ marginTop: 10 }}><Field label="BOQ Line Item"><input value={boqItem} onChange={e => setBoqItem(e.target.value)} /></Field><Field label="Amount (ZAR)"><input type="number" value={boqAmt} onChange={e => setBoqAmt(e.target.value)} /></Field></div>
          <button className="btn accent" onClick={() => { onAddBoq(project.id, boqItem, boqAmt); setBoqItem(""); setBoqAmt(""); }} disabled={!boqItem || !boqAmt}>Add BOQ Line</button>
        </div>
      )}
      {tab === "Capitalise" && (
        <div className="inline-form">
          <div className="hint">Unbundle the commissioned project into individual fixed asset records before moving from WIP to the asset register. Component values must sum to the total capitalised cost.</div>
          {capLines.map((l, i) => (<div className="row2" key={i} style={{ marginBottom: 6 }}><input value={l.desc} onChange={e => setCapLines(cl => cl.map((c, ci) => ci === i ? { ...c, desc: e.target.value } : c))} /><input type="number" value={l.value} onChange={e => setCapLines(cl => cl.map((c, ci) => ci === i ? { ...c, value: e.target.value } : c))} /></div>))}
          <button className="btn ghost" onClick={() => setCapLines(cl => [...cl, { desc: project.name + " — Component " + (cl.length + 1), value: 0 }])}>+ Add Component</button>
          <div className="kv" style={{ marginTop: 8 }}><span>Component Total</span><span style={{ fontWeight: 700, color: capTotal === project.budget ? "var(--ok)" : "var(--danger)" }}>{fmtZAR(capTotal)} / {fmtZAR(project.budget)}</span></div>
          <button className="btn accent" style={{ marginTop: 10 }} disabled={capTotal !== project.budget} onClick={() => { onCapitalise(project.id, capLines); onClose(); }}>Unbundle & Capitalise Project</button>
        </div>
      )}
    </Modal>
  );
}

/* =====================================================================
   MAINTENANCE
===================================================================== */
function MaintenanceView({ assets, maintenance, onAdd, onSetStatus }) {
  const [assetId, setAssetId] = useState(assets[0]?.id);
  const [desc, setDesc] = useState(""); const [due, setDue] = useState("");
  function submit() { if (!desc || !due) return; onAdd(assetId, desc, due); setDesc(""); setDue(""); }
  return (
    <div className="grid-2">
      <div className="card">
        <h3>Maintenance Schedule <InfoTip title="Maintenance Schedule">Tracks upkeep work against assets — from a scheduled generator load test to an ad-hoc repair.
          <ul>
            <li><b>Requested</b>: logged, not yet scheduled</li>
            <li><b>Scheduled</b>: has a confirmed date</li>
            <li><b>Completed</b>: work finished</li>
          </ul>
        </InfoTip></h3><div className="hint">Preventive & reactive maintenance across the asset base.</div>
        <table>
          <thead><tr><th>Asset</th><th>Work</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>
            {maintenance.map(m => {
              const a = assets.find(x => x.id === m.assetId);
              return (<tr key={m.id}><td>{a?.desc || m.assetId}</td><td>{m.desc}</td><td>{m.due}</td>
                <td><Badge color={m.status === "Completed" ? "var(--ok)" : m.status === "Scheduled" ? "var(--warn)" : "var(--muted)"}>{m.status}</Badge></td>
                <td>{m.status !== "Completed" && <button className="btn ghost" onClick={() => onSetStatus(m.id, m.status === "Requested" ? "Scheduled" : "Completed")}>{m.status === "Requested" ? "Schedule" : "Mark Complete"}</button>}</td></tr>);
            })}
          </tbody>
        </table>
        {maintenance.length === 0 && <div className="hint">No maintenance requests logged yet.</div>}
      </div>
      <div className="card">
        <h3>Log Maintenance Request</h3>
        <Field label="Asset"><select value={assetId} onChange={e => setAssetId(e.target.value)}>{assets.map(a => <option key={a.id} value={a.id}>{a.desc}</option>)}</select></Field>
        <Field label="Work Description"><input value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Annual service" /></Field>
        <Field label="Due Date"><input type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
        <button className="btn accent" onClick={submit}>Log Request</button>
      </div>
    </div>
  );
}

/* =====================================================================
   BULK DATA & DOCUMENTS
===================================================================== */
function BulkDataView({ assets, onImport, onMerge }) {
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);

  function downloadTemplate() {
    const header = "barcode,description,category,location,custodian,purchaseDate,price\n";
    const sample = "DIRCO-0099001,Sample Office Chair,Office Furniture,Head Office (OR Tambo Bld),J. Smith,2026-01-15,3200\n";
    downloadText("asset_bulk_upload_template.csv", header + sample);
  }
  function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const lines = String(ev.target.result).trim().split("\n").filter(Boolean);
      const [headerLine, ...dataLines] = lines;
      const cols = headerLine.split(",").map(c => c.trim());
      const rows = dataLines.map(line => {
        const vals = line.split(","); const row = {}; cols.forEach((c, i) => row[c] = (vals[i] || "").trim());
        const errors = [];
        if (!row.barcode) errors.push("missing barcode");
        if (!row.description) errors.push("missing description");
        if (!CATEGORIES.includes(row.category)) errors.push("unknown category");
        if (isNaN(Number(row.price))) errors.push("price not numeric");
        if (assets.some(a => a.barcode === row.barcode)) errors.push("duplicate barcode");
        return { ...row, price: Number(row.price), errors };
      });
      setPreview(rows);
    };
    reader.readAsText(file);
  }
  async function importValid() {
    const valid = preview.filter(r => r.errors.length === 0);
    await onImport(valid);
    setPreview(null);
  }
  const duplicates = useMemo(() => {
    const bySerial = {};
    assets.forEach(a => { if (a.serial && a.serial !== "N/A") { bySerial[a.serial] = bySerial[a.serial] || []; bySerial[a.serial].push(a); } });
    return Object.values(bySerial).filter(g => g.length > 1);
  }, [assets]);

  return (
    <>
      <div className="card">
        <h3>Bulk Data Upload <InfoTip title="Bulk Data Upload">Loads many assets at once from a CSV file instead of capturing them one by one — useful for migrating from a legacy system or a large annual intake. Each row is checked before import: missing required fields, an unrecognised category, a non-numeric price, or a barcode that already exists in the register will all be flagged and excluded, while valid rows import normally.</InfoTip></h3><div className="hint">Upload asset inventory in CSV format. Rows are validated before import.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" onClick={downloadTemplate}><Download size={14} /> Download CSV Template</button>
          <button className="btn accent" onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload CSV</button>
        </div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleFile} />
        {preview && (
          <div style={{ marginTop: 14 }}>
            <table>
              <thead><tr><th>Barcode</th><th>Description</th><th>Category</th><th>Price</th><th>Validation</th></tr></thead>
              <tbody>{preview.map((r, i) => (<tr key={i}><td>{r.barcode}</td><td>{r.description}</td><td>{r.category}</td><td>{r.price}</td>
                <td>{r.errors.length === 0 ? <Badge color="var(--ok)" icon={CheckCircle2}>Valid</Badge> : <Badge color="var(--danger)" icon={AlertTriangle}>{r.errors.join(", ")}</Badge>}</td></tr>))}</tbody>
            </table>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="btn accent" onClick={importValid}>Import {preview.filter(r => r.errors.length === 0).length} Valid Row(s)</button>
              <button className="btn ghost" onClick={() => setPreview(null)}>Discard</button>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <h3>Duplicate Detection & Merge <InfoTip title="Duplicate Detection & Merge">Automatically finds assets that share the same <b>serial number</b> — a strong signal they're actually the same physical item captured twice (e.g. once manually, once via bulk upload). "Merge" keeps the older record, moves over any photos/documents/history from the duplicate, and permanently deletes the duplicate row.</InfoTip></h3><div className="hint">Assets sharing the same serial number, flagged for review.</div>
        {duplicates.length === 0 && <div className="hint">No duplicates detected.</div>}
        {duplicates.map((g, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px dashed var(--border)" }}>
            <div style={{ fontSize: 13 }}><GitMerge size={13} style={{ marginRight: 6 }} />{g.map(a => a.desc).join("  ↔  ")} <span style={{ color: "var(--text-dim)" }}>(serial {g[0].serial})</span></div>
            <button className="btn ghost" onClick={() => onMerge(g)}>Merge</button>
          </div>
        ))}
      </div>
    </>
  );
}

/* =====================================================================
   GRAP CLASSIFICATION
===================================================================== */
function GrapView({ classes, assets, onAdd, onToggle, onSetUsefulLife }) {
  const [name, setName] = useState(""); const [type, setType] = useState("Movable"); const [life, setLife] = useState(5);
  function addClass() { if (!name) return; onAdd(name, type, Number(life) || null); setName(""); }
  const countByClass = c => assets.filter(a => a.category === c.name).length;
  return (
    <div className="grid-2">
      <div className="card">
        <h3>Asset Classification Library <InfoTip title="GRAP Classification">GRAP (Generally Recognised Accounting Practice) is the public-sector accounting standard DIRCO must follow. Every asset needs a standard <b>class</b> (e.g. "ICT Equipment") and <b>type</b> ("Movable" or "Immovable" — i.e. can it be physically relocated). "Predefined (GRAP)" classes ship with the system and can only be deactivated, never deleted, to keep historical reporting consistent; "Custom" classes can be added freely for anything DIRCO-specific. <b>Useful Life</b> drives the depreciation calculation on the Depreciation screen — change it here and every asset in that class recalculates automatically.</InfoTip></h3><div className="hint">Manage the class/type structure used for item-level GRAP register management.</div>
        <table>
          <thead><tr><th>Class</th><th>Type</th><th>Useful Life (yrs)</th><th>Assets</th><th>Source</th><th>Active</th></tr></thead>
          <tbody>{classes.map(c => (<tr key={c.id}><td>{c.name}</td><td>{c.type}</td>
            <td><input type="number" style={{ width: 60 }} defaultValue={c.usefulLifeYears || ""} placeholder="5" onBlur={e => onSetUsefulLife(c.id, Number(e.target.value) || null)} /></td>
            <td>{countByClass(c)}</td>
            <td>{c.predefined ? <Badge color="var(--secondary)">Predefined (GRAP)</Badge> : <Badge color="var(--accent)">Custom</Badge>}</td>
            <td><button className="btn ghost" onClick={() => onToggle(c.id, c.active)}>{c.active ? "Deactivate" : "Activate"}</button></td></tr>))}</tbody>
        </table>
      </div>
      <div className="card">
        <h3>Add Classification</h3><div className="hint">Extend the structure without vendor intervention. Predefined GRAP classes cannot be deleted, only deactivated.</div>
        <Field label="Class Name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Type"><select value={type} onChange={e => setType(e.target.value)}><option>Movable</option><option>Immovable</option></select></Field>
        <Field label="Useful Life (years)"><input type="number" value={life} onChange={e => setLife(e.target.value)} /></Field>
        <button className="btn accent" onClick={addClass}>Add Class</button>
      </div>
    </div>
  );
}

/* =====================================================================
   SCOA & REPORTING
===================================================================== */
function ScoaView({ assets }) {
  const [groupBy, setGroupBy] = useState("category");
  const groups = useMemo(() => {
    const map = {};
    assets.forEach(a => {
      const key = groupBy === "category" ? a.category : groupBy === "location" ? a.location : groupBy === "fundingSource" ? a.fundingSource : a.costCentre;
      map[key] = map[key] || { count: 0, value: 0 }; map[key].count++; map[key].value += a.price;
    });
    return map;
  }, [assets, groupBy]);
  function exportReport() {
    let text = `SCOA Roll-Up Report — grouped by ${groupBy}\nGenerated: ${nowStamp()}\n\n`;
    Object.entries(groups).forEach(([k, v]) => { text += `${k}: ${v.count} assets, ${fmtZAR(v.value)}\n`; });
    downloadText("scoa_rollup_report.txt", text);
  }
  return (
    <div className="grid-2">
      <div className="card">
        <h3>SCOA Compliance <InfoTip title="SCOA Compliance">SCOA (Standard Chart of Accounts) is National Treasury's mandatory classification structure for all government spending. <b>Fund</b> = which budget vote paid for it; <b>Function</b> = the broad government function it serves; <b>Item</b> = the specific expenditure category. Every asset must carry all three, plus a <b>Funding Source</b> (Voted Funds, Donor Funding, Own Revenue, or Donation) — the Capture Asset form won't save without an Item segment.</InfoTip></h3><div className="hint">Every asset captured carries mandatory SCOA segments (Fund, Function, Item) and a funding source, validated at capture.</div>
        <table><thead><tr><th>Asset</th><th>Fund</th><th>Function</th><th>Item</th><th>Funding Source</th></tr></thead>
          <tbody>{assets.slice(0, 8).map(a => <tr key={a.id}><td>{a.desc}</td><td>{a.scoa.fund}</td><td>{a.scoa.func}</td><td>{a.scoa.item || "—"}</td><td>{a.fundingSource}</td></tr>)}</tbody></table>
      </div>
      <div className="card">
        <h3>Roll-Up Reporting <InfoTip title="Roll-Up Reporting">"Rolling up" means grouping and totalling assets by a chosen dimension instead of listing every one individually — e.g. total value per Mission, or per Cost Centre. Useful for management reports and Treasury submissions at whatever level of detail is needed.</InfoTip></h3><div className="hint">Report to any level required by DIRCO.</div>
        <Field label="Group By"><select value={groupBy} onChange={e => setGroupBy(e.target.value)}><option value="category">Asset Class</option><option value="location">Mission / Location</option><option value="fundingSource">Funding Source</option><option value="costCentre">Cost Centre</option></select></Field>
        <table><thead><tr><th>{groupBy}</th><th>Count</th><th>Value</th></tr></thead><tbody>{Object.entries(groups).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.count}</td><td>{fmtZAR(v.value)}</td></tr>)}</tbody></table>
        <button className="btn accent" style={{ marginTop: 10 }} onClick={exportReport}><Download size={14} /> Export Report</button>
      </div>
    </div>
  );
}

/* =====================================================================
   VERIFICATION
===================================================================== */
function VerifyView({ assets, cycles, missions, onPlan, onScan, onClose }) {
  const [scope, setScope] = useState(missions[0]?.name || "");
  const [due, setDue] = useState("2026-09-30");
  const [scanInput, setScanInput] = useState("");
  const [scanMsg, setScanMsg] = useState(null);
  const [activeCycle, setActiveCycle] = useState(cycles[0]?.id || "");

  useEffect(() => { if (!activeCycle && cycles.length) setActiveCycle(cycles[0].id); }, [cycles, activeCycle]);

  async function handlePlan() { const id = await onPlan(scope, due); if (id) setActiveCycle(id); }
  async function handleScan() { const res = await onScan(activeCycle, scanInput); setScanMsg(res); if (res?.ok) setScanInput(""); }
  function exportExceptions(cycle) {
    const missingIds = cycle.assetIds.filter(aid => !cycle.verifiedIds.includes(aid));
    const rows = missingIds.map(id => assets.find(a => a.id === id)).filter(Boolean);
    let text = `Verification Exceptions — ${cycle.scope}\nGenerated: ${nowStamp()}\n\n`;
    rows.forEach(a => text += `${a.barcode} — ${a.desc} — last known custodian ${a.custodian}\n`);
    downloadText("verification_exceptions.txt", text);
  }

  return (
    <>
      <div className="grid-2">
        <div className="card">
          <h3>Plan a Verification Cycle <InfoTip title="Verification Cycle">A <b>verification cycle</b> is a physical stock-take for a specific site — every asset recorded at that location becomes a "task" that field officers must confirm still exists. Creating one here snapshots the current list of assets for that location so you know exactly what's in scope.</InfoTip></h3><div className="hint">iOS/Android scanning app users are assigned a task list generated from this scope.</div>
          <Field label="Scope (Mission / Location)"><select value={scope} onChange={e => setScope(e.target.value)}>{missions.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></Field>
          <Field label="Due Date"><input type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
          <button className="btn accent" onClick={handlePlan}><ClipboardList size={14} /> Create Verification Cycle</button>
        </div>
        <div className="card">
          <h3>Scan a Barcode <InfoTip title="Scan a Barcode">Simulates what the mobile scanning app does in the field: typing/scanning a barcode looks it up against the Fixed Asset Register and, if it's in scope for the selected cycle, marks it "verified" — found and confirmed present. Scanning something not in this cycle's scope, or already verified, tells you so instead.</InfoTip></h3><div className="hint">Simulated mobile-app scan input, matched live against the FAR.</div>
          <Field label="Active Cycle"><select value={activeCycle} onChange={e => setActiveCycle(e.target.value)}>{cycles.filter(c => !c.closed).map(c => <option key={c.id} value={c.id}>{c.scope} — due {c.due}</option>)}</select></Field>
          <Field label="Barcode"><input value={scanInput} onChange={e => setScanInput(e.target.value)} placeholder="e.g. DIRCO-0010231" onKeyDown={e => e.key === "Enter" && handleScan()} /></Field>
          <button className="btn accent" onClick={handleScan}><ScanBarcode size={14} /> Simulate Scan</button>
          {scanMsg && <div style={{ marginTop: 10 }}><Badge color={scanMsg.ok ? "var(--ok)" : "var(--danger)"} icon={scanMsg.ok ? CheckCircle2 : AlertTriangle}>{scanMsg.text}</Badge></div>}
        </div>
      </div>
      <div className="card">
        <h3>User Output Monitoring <InfoTip title="User Output Monitoring">Shows exactly which officer verified which asset and when — required so a supervisor can confirm the verification work was actually done by the assigned team, not just that the cycle's overall % went up.</InfoTip></h3>
        <div className="hint">Per-officer scan activity across all cycles, most recent first.</div>
        {(() => {
          const allScans = cycles.flatMap(c => (c.scanLog || []).map(s => ({ ...s, cycleScope: c.scope })));
          if (allScans.length === 0) return <div className="hint">No scans recorded yet.</div>;
          const byOfficer = {};
          allScans.forEach(s => { byOfficer[s.verifiedBy] = (byOfficer[s.verifiedBy] || 0) + 1; });
          return (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                {Object.entries(byOfficer).map(([officer, n]) => <Badge key={officer} color="var(--accent)"><User size={11} />{officer}: {n} scanned</Badge>)}
              </div>
              <table>
                <thead><tr><th>Asset</th><th>Site</th><th>Verified By</th><th>Verified At</th></tr></thead>
                <tbody>{allScans.slice(0, 10).map((s, i) => {
                  const a = assets.find(x => x.id === s.assetId);
                  return <tr key={i}><td>{a?.desc || s.assetId}</td><td>{s.cycleScope}</td><td>{s.verifiedBy}</td><td>{s.verifiedAt}</td></tr>;
                })}</tbody>
              </table>
            </>
          );
        })()}
      </div>
      <div className="card">
        <h3>Verification Cycles <InfoTip title="Closing a Cycle">"Close Cycle & Raise Exceptions" locks the cycle and marks every asset that was in scope but never scanned as <b>Missing</b> — these become the exceptions that need investigating. The progress bar and % show scanned-vs-total for that cycle; colour follows the same green/amber/red thresholds as the Dashboard.</InfoTip></h3>
        {cycles.map(c => {
          const pct = c.assetIds.length ? Math.round(c.verifiedIds.length / c.assetIds.length * 100) : 0;
          return (
            <div key={c.id} style={{ padding: "10px 0", borderBottom: "1px dashed var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span><b>{c.scope}</b> — {c.verifiedIds.length}/{c.assetIds.length} verified {c.closed && <Badge color="var(--muted)">Closed</Badge>}</span>
                <span style={{ color: "var(--text-dim)" }}>due {c.due}</span>
              </div>
              <ProgressBar pct={pct} color={pct >= 70 ? "var(--ok)" : pct >= 40 ? "var(--warn)" : "var(--danger)"} />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                {!c.closed && <button className="btn ghost" onClick={() => onClose(c.id)}>Close Cycle & Raise Exceptions</button>}
                <button className="btn ghost" onClick={() => exportExceptions(c)}><FileSearch size={13} /> Export Exceptions Report</button>
              </div>
            </div>
          );
        })}
        {cycles.length === 0 && <div className="hint">No verification cycles yet.</div>}
      </div>
    </>
  );
}

/* =====================================================================
   QUARTERLY COMPLIANCE
===================================================================== */
function QuarterlyView({ assets, correctionJournals, glMapping, classes, onDonate, onAddCorrection, log }) {
  const [donor, setDonor] = useState(""); const [donValue, setDonValue] = useState(""); const [donDesc, setDonDesc] = useState("");
  const [cjAsset, setCjAsset] = useState(assets[0]?.id); const [cjReason, setCjReason] = useState(""); const [cjEvidence, setCjEvidence] = useState(""); const [cjApprover, setCjApprover] = useState("");
  const [completeness, setCompleteness] = useState(null);
  const [evidenceAsset, setEvidenceAsset] = useState(assets[0]?.id);
  const [journalPeriod, setJournalPeriod] = useState("2025-04-01");

  function submitDonation() { if (!donor || !donValue || !donDesc) return; onDonate(donDesc, donor, Number(donValue)); setDonor(""); setDonValue(""); setDonDesc(""); }
  const additionsThisFY = assets.filter(a => a.purchaseDate >= "2025-04-01").reduce((s, a) => s + a.price, 0);
  const glAdditionsMock = additionsThisFY * 0.97;
  const variance = additionsThisFY - glAdditionsMock;
  const journal = useMemo(() => buildGlJournal(assets, glMapping, journalPeriod, classes), [assets, glMapping, journalPeriod, classes]);
  function exportJournal() {
    downloadText(`gl_journal_batch_${journalPeriod}_to_${new Date().toISOString().slice(0, 10)}.csv`, glJournalToCsv(journal.rows));
    log(`GL journal batch exported: ${journal.rows.length} lines, ${fmtZAR(journal.totalDebit)} debit / ${fmtZAR(journal.totalCredit)} credit.`);
  }
  function submitCorrection() { if (!cjReason || !cjEvidence || !cjApprover) return; onAddCorrection(cjAsset, cjReason, cjEvidence, cjApprover); setCjReason(""); setCjEvidence(""); setCjApprover(""); }
  function runCompleteness() {
    const issues = [];
    assets.forEach(a => {
      const missing = [];
      if (!a.custodian) missing.push("custodian"); if (!a.costCentre) missing.push("cost centre"); if (!a.location) missing.push("location"); if (a.price === 0) missing.push("zero value");
      if (missing.length) issues.push({ asset: a.desc, id: a.id, missing });
    });
    setCompleteness(issues); log(`FAR completeness review executed: ${issues.length} record(s) flagged.`);
  }
  const disclosure = useMemo(() => {
    const byCat = {}; CATEGORIES.forEach(c => byCat[c] = { opening: 0, additions: 0, disposals: 0, depreciation: 0, closing: 0 });
    assets.forEach(a => {
      const cat = byCat[a.category]; if (!cat) return;
      const isAddition = a.purchaseDate >= "2025-04-01"; const dep = computeDepreciation(a, classes);
      if (a.status === "Disposed") cat.disposals += a.price;
      if (isAddition) cat.additions += a.price; else cat.opening += a.price;
      cat.depreciation += dep.accumulated;
    });
    Object.values(byCat).forEach(c => c.closing = c.opening + c.additions - c.disposals - c.depreciation);
    return byCat;
  }, [assets, classes]);
  function exportDisclosure() {
    let text = "AFS Disclosure Note — Property, Plant & Equipment\nGenerated: " + nowStamp() + "\n\n";
    Object.entries(disclosure).forEach(([cat, v]) => { text += `${cat}\n  Opening: ${fmtZAR(v.opening)}\n  Additions: ${fmtZAR(v.additions)}\n  Disposals: ${fmtZAR(v.disposals)}\n  Depreciation: ${fmtZAR(v.depreciation)}\n  Closing: ${fmtZAR(v.closing)}\n\n`; });
    downloadText("afs_disclosure_note.txt", text);
  }
  function generateEvidencePack() {
    const a = assets.find(x => x.id === evidenceAsset); if (!a) return;
    let text = `Audit Evidence Pack — ${a.desc} (${a.barcode})\nGenerated: ${nowStamp()}\n\nCategory: ${a.category}\nLocation: ${a.location} — ${a.room}\nCustodian: ${a.custodian}\nStatus: ${a.status}\nPurchase: ${a.purchaseDate}, ${fmtZAR(a.price)}\n\nHistory:\n`;
    a.history.forEach(h => text += `  - ${h.ts}: ${h.type} — ${h.note}\n`);
    text += `\nDocuments:\n`; a.documents.forEach(d => text += `  - ${d.name} (${d.ts})\n`);
    downloadText(`evidence_pack_${a.id}.txt`, text); log(`Audit evidence pack generated for ${a.id}.`);
  }

  return (
    <>
      <div className="grid-2">
        <div className="card">
          <h3>Donated Asset Capitalisation <InfoTip title="Donated Assets">When someone donates an asset to DIRCO (rather than it being purchased), it still needs to be added to the FAR at a fair assessed value so it's properly accounted for. This creates a new asset record tagged with Funding Source = "Donation".</InfoTip></h3><div className="hint">Identify and capitalise donated assets, compiled as FAR additions.</div>
          <Field label="Donor"><input value={donor} onChange={e => setDonor(e.target.value)} /></Field>
          <Field label="Asset Description"><input value={donDesc} onChange={e => setDonDesc(e.target.value)} /></Field>
          <Field label="Assessed Value (ZAR)"><input type="number" value={donValue} onChange={e => setDonValue(e.target.value)} /></Field>
          <button className="btn accent" onClick={submitDonation}><Gift size={14} /> Capitalise Donation</button>
        </div>
        <div className="card">
          <h3>FAR ↔ GL Reconciliation <InfoTip title="FAR ↔ GL Reconciliation">The <b>FAR</b> (Fixed Asset Register — this system) and the <b>GL</b> (General Ledger — the department's accounting system) should always agree on how much was added in new assets this year. This card compares the two totals; a large <b>Variance</b> (shown in red) signals a discrepancy that needs investigating before financial statements are finalised. (The GL figure here is a placeholder pending real GL/ERP integration.)</InfoTip></h3><div className="hint">Reconcile immovable/movable asset additions to the General Ledger.</div>
          <div className="kv"><span>FAR Additions (this FY)</span><span>{fmtZAR(additionsThisFY)}</span></div>
          <div className="kv"><span>GL Additions (this FY)</span><span>{fmtZAR(glAdditionsMock)}</span></div>
          <div className="kv" style={{ fontWeight: 700 }}><span>Variance</span><span style={{ color: Math.abs(variance) < 1000 ? "var(--ok)" : "var(--danger)" }}>{fmtZAR(variance)}</span></div>
        </div>
      </div>

      <div className="card">
        <h3>GL Journal Batch Export <InfoTip title="GL Journal Batch Export">Generates a real, balanced double-entry journal (debits = credits) covering acquisitions, depreciation, and disposals since the period start you choose, using the account codes from GL / ERP Account Mapping (System Admin). Download it as a CSV and import it into DIRCO's actual GL/ERP system.
          <ul>
            <li><b>Acquisitions</b>: Dr the asset's mapped account, Cr Creditors Control</li>
            <li><b>Depreciation</b>: Dr Depreciation Expense, Cr Accumulated Depreciation (summarised by category)</li>
            <li><b>Disposals</b>: Cr the asset account at cost, Dr Accumulated Depreciation, Dr Disposal Proceeds, and a balancing Profit/Loss line</li>
          </ul>
          The control account codes (Creditors, Depreciation Expense, etc.) are placeholders in <code>GL_CONTROL_ACCOUNTS</code> in the code — replace them with DIRCO's real account codes before posting anything live.</InfoTip></h3>
        <div className="hint">This does not post anywhere automatically — it produces a file for your accountant to review and import.</div>
        <div className="row2">
          <Field label="Period Start"><input type="date" value={journalPeriod} onChange={e => setJournalPeriod(e.target.value)} /></Field>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn accent" onClick={exportJournal} disabled={journal.rows.length === 0}><Download size={14} /> Export Journal Batch (CSV)</button>
          </div>
        </div>
        <div className="kv"><span>Journal Lines</span><span>{journal.rows.length}</span></div>
        <div className="kv"><span>Total Debit</span><span>{fmtZAR(journal.totalDebit)}</span></div>
        <div className="kv"><span>Total Credit</span><span>{fmtZAR(journal.totalCredit)}</span></div>
        <div className="kv" style={{ fontWeight: 700 }}><span>Balance Check</span><span style={{ color: journal.balanced ? "var(--ok)" : "var(--danger)" }}>{journal.balanced ? "✓ Balanced" : "⚠ Not balanced — check the data"}</span></div>
        {journal.unmapped.length > 0 && (
          <div className="hint" style={{ color: "var(--warn)", marginTop: 6 }}>
            ⚠ These categories have no GL code mapped yet, so they posted to the suspense account — set them in GL / ERP Account Mapping (System Admin): {journal.unmapped.join(", ")}
          </div>
        )}
        {journal.rows.length === 0 && <div className="hint">No acquisitions, depreciation, or disposals found for this period.</div>}
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Correction Journals <InfoTip title="Correction Journals">A formal, auditable way to fix a mistake in the register — e.g. a wrong value captured last quarter. Every correction requires a reason, an evidence reference (what document backs up the change), and an approver's name, so there's always a paper trail explaining why a number changed.</InfoTip></h3><div className="hint">Controlled, auditable correction of FAR/GL errors.</div>
          <Field label="Asset"><select value={cjAsset} onChange={e => setCjAsset(e.target.value)}>{assets.map(a => <option key={a.id} value={a.id}>{a.desc}</option>)}</select></Field>
          <Field label="Reason"><input value={cjReason} onChange={e => setCjReason(e.target.value)} /></Field>
          <div className="row2"><Field label="Evidence Reference"><input value={cjEvidence} onChange={e => setCjEvidence(e.target.value)} /></Field><Field label="Approver"><input value={cjApprover} onChange={e => setCjApprover(e.target.value)} /></Field></div>
          <button className="btn accent" onClick={submitCorrection}>Log Correction Journal</button>
          {correctionJournals.length > 0 && (<div style={{ marginTop: 10 }}>{correctionJournals.map(cj => <div key={cj.id} style={{ fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed var(--border)" }}>{cj.assetId} — {cj.reason} <span style={{ color: "var(--text-dim)" }}>(approved by {cj.approver}, {cj.ts})</span></div>)}</div>)}
        </div>
        <div className="card">
          <h3>FAR Completeness Review <InfoTip title="FAR Completeness Review">Scans every asset for common data-quality problems — a missing custodian, cost centre, or location, or a price of zero — that would make the register non-compliant if left unresolved. Run it before an audit to catch issues early.</InfoTip></h3><div className="hint">Full review of the register for completeness and compliance.</div>
          <button className="btn accent" onClick={runCompleteness}><ListChecks size={14} /> Run Completeness Check</button>
          {completeness && (<div style={{ marginTop: 10 }}>{completeness.length === 0 ? <div className="hint">No issues found — register is complete.</div> : completeness.map(i => <div key={i.id} style={{ fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed var(--border)" }}><b>{i.asset}</b>: missing {i.missing.join(", ")}</div>)}</div>)}
        </div>
      </div>
      <div className="card">
        <h3>AFS Disclosure Note <InfoTip title="AFS Disclosure Note">The Annual Financial Statements (AFS) require a note showing how each asset class's value moved over the year:
          <ul>
            <li><b>Opening</b>: value at the start of the year (assets bought before this FY)</li>
            <li><b>Additions</b>: new assets bought this year</li>
            <li><b>Disposals</b>: value of assets disposed of this year</li>
            <li><b>Depreciation</b>: value "used up" this year</li>
            <li><b>Closing</b>: Opening + Additions − Disposals − Depreciation</li>
          </ul>
        </InfoTip></h3><div className="hint">Opening balance, additions, disposals, depreciation and closing balance by asset class.</div>
        <table><thead><tr><th>Class</th><th>Opening</th><th>Additions</th><th>Disposals</th><th>Depreciation</th><th>Closing</th></tr></thead>
          <tbody>{Object.entries(disclosure).map(([cat, v]) => <tr key={cat}><td>{cat}</td><td>{fmtZAR(v.opening)}</td><td>{fmtZAR(v.additions)}</td><td>{fmtZAR(v.disposals)}</td><td>{fmtZAR(v.depreciation)}</td><td style={{ fontWeight: 700 }}>{fmtZAR(v.closing)}</td></tr>)}</tbody></table>
        <button className="btn accent" style={{ marginTop: 10 }} onClick={exportDisclosure}><Download size={14} /> Export Disclosure Note</button>
      </div>
      <div className="card">
        <h3>External Audit Support <InfoTip title="Audit Evidence Pack">Bundles everything an auditor might ask about a specific asset — its details, full transfer/change history, and attached documents — into a single downloadable file, so you're not hunting through the system live during an audit enquiry.</InfoTip></h3><div className="hint">Generate an evidence pack for a selected asset to respond to audit enquiries.</div>
        <div className="row2"><Field label="Asset"><select value={evidenceAsset} onChange={e => setEvidenceAsset(e.target.value)}>{assets.map(a => <option key={a.id} value={a.id}>{a.desc}</option>)}</select></Field>
          <div style={{ display: "flex", alignItems: "flex-end" }}><button className="btn accent" onClick={generateEvidencePack}><FileSearch size={14} /> Generate Evidence Pack</button></div></div>
      </div>
    </>
  );
}

/* =====================================================================
   SECURITY & ACCESS
===================================================================== */
function SecurityView({ team, loginAudit, passwordPolicy, authUser, missions, logsLastRefresh, logsRefreshing, onRefreshLogs, onStatus, onVet, onRole, onDelete, onPolicyChange, onPolicySave, onCreateUser }) {
  const [showCreate, setShowCreate] = useState(false);
  const canManage = authUser?.role === "System Owner" || authUser?.role === "Mission Admin";
  const canChangeRole = authUser?.role === "System Owner";
  const canSeePolicy = ["System Owner", "Head Office Admin"].includes(authUser?.role);
  const isTopRole = authUser?.role === "System Owner" || authUser?.role === "Head Office Admin";
  const ALL_ROLES = ["System Owner", "Head Office Admin", "Mission Admin", "Custodian"];

  function canDeleteUser(u) {
    if (isTopRole) return true;
    if (authUser?.role === "Mission Admin") return u.role === "Custodian";
    return false;
  }
  function handleDelete(u) {
    if (window.confirm(`Remove ${u.name} from the roster? This cannot be undone.`)) onDelete(u.id);
  }
  function exportLoginAudit() {
    const header = "User,Outcome,IP,Timestamp\n";
    const body = loginAudit.map(l => [l.user, l.outcome, l.ip, l.ts].map(v => `"${(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadText(`login_audit_${new Date().toISOString().slice(0, 10)}.csv`, header + body + "\n");
  }

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ marginBottom: 0 }}>User Access <InfoTip title="User Access & Roles">Role-based access control, now scoped by mission:
            <ul>
              <li><b>System Owner</b>: full control — defines missions, creates any account, sees and approves everything, can remove any user</li>
              <li><b>Head Office Admin</b>: sees all missions' data, approves cross-mission transfers, can remove any user</li>
              <li><b>Mission Admin</b>: scoped to one mission — creates Custodians within it, approves in-mission actions, can remove Custodians</li>
              <li><b>Custodian</b>: the employee an asset is assigned to — an employee record only, no system login.</li>
            </ul>
            <b>Pending Vetting</b> blocks login until clearance is confirmed. <b>Suspended</b> blocks login immediately.
          </InfoTip></h3>
          {canManage && <button className="btn accent" onClick={() => setShowCreate(true)}><Plus size={14} /> Create User</button>}
        </div>
        <div className="hint">Role-based access control · security vetting required before activation · scoped by mission.</div>
        <table><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Mission</th><th>Last Login</th><th>Status</th><th /></tr></thead>
          <tbody>{team.map(u => (
            <tr key={u.id}>
              <td style={{ display: "flex", alignItems: "center", gap: 6 }}><User size={13} />{u.name}</td>
              <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{u.email || <Badge color="var(--muted)">No login</Badge>}</td>
              <td>{canChangeRole ? <select value={u.role} onChange={e => onRole(u.id, e.target.value)}>{ALL_ROLES.map(r => <option key={r}>{r}</option>)}</select> : u.role}</td>
              <td style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{u.missionName || "—"}</td>
              <td style={{ color: "var(--text-dim)" }}>{u.lastLogin}</td>
              <td><Badge color={u.status === "Active" ? "var(--ok)" : u.status === "Pending Vetting" ? "var(--warn)" : "var(--danger)"}>{u.status}</Badge></td>
              <td style={{ display: "flex", gap: 6 }}>
                {canManage && u.email && (u.status === "Pending Vetting" ? <button className="btn accent" onClick={() => onVet(u.id)}>Confirm Clearance</button> : <button className="btn ghost" onClick={() => onStatus(u.id, u.status === "Active" ? "Suspended" : "Active")}>{u.status === "Active" ? "Suspend" : "Reactivate"}</button>)}
                {canDeleteUser(u) && <button className="btn ghost" style={{ color: "var(--danger)" }} onClick={() => handleDelete(u)}>Remove</button>}
              </td>
            </tr>))}</tbody></table>
        {!canManage && <div className="hint" style={{ marginTop: 8 }}>Signed in as {authUser?.role} — creating users and changing status requires a System Owner or Mission Admin account.</div>}
      </div>
      {canSeePolicy && (
      <div className="grid-2">
        <div className="card">
          <h3><KeyRound size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />Password Policy <InfoTip title="Password Policy">
            <ul>
              <li><b>Minimum Length</b>: shortest password the system will accept</li>
              <li><b>Password Expiry</b>: how many days before a user must set a new password</li>
              <li><b>Password History</b>: how many previous passwords can't be reused</li>
              <li><b>Require Complexity</b>: whether uppercase/numbers/symbols are mandatory</li>
            </ul>
          </InfoTip></h3>
          <div className="row2"><Field label="Minimum Length"><input type="number" value={passwordPolicy.minLength} onChange={e => onPolicyChange({ minLength: Number(e.target.value) })} onBlur={onPolicySave} /></Field>
            <Field label="Password Expiry (days)"><input type="number" value={passwordPolicy.expiryDays} onChange={e => onPolicyChange({ expiryDays: Number(e.target.value) })} onBlur={onPolicySave} /></Field></div>
          <div className="row2"><Field label="Password History (reuse prevention)"><input type="number" value={passwordPolicy.historyCount} onChange={e => onPolicyChange({ historyCount: Number(e.target.value) })} onBlur={onPolicySave} /></Field>
            <Field label="Require Complexity"><select value={passwordPolicy.complexity ? "Yes" : "No"} onChange={e => { onPolicyChange({ complexity: e.target.value === "Yes" }); onPolicySave(); }}><option>Yes</option><option>No</option></select></Field></div>
          <div className="hint">Applies to all users at next password reset. Saved to Postgres on blur.</div>
        </div>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ marginBottom: 0 }}>Login Audit Log <InfoTip title="Login Audit Log">A record of every login attempt, successful or failed, with the user, IP address, and timestamp — used to detect suspicious activity like repeated failed logins from an unfamiliar IP.</InfoTip></h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {logsLastRefresh && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Updated {logsLastRefresh.toLocaleTimeString()}</span>}
              <button className="btn ghost" onClick={onRefreshLogs} disabled={logsRefreshing}><RefreshCw size={13} className={logsRefreshing ? "spin" : ""} /> Refresh</button>
              <button className="btn ghost" onClick={exportLoginAudit}><Download size={13} /> Export CSV</button>
            </div>
          </div>
          <div className="hint">Successful and failed login attempts.</div>
          {loginAudit.map(l => <div key={l.id} style={{ fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed var(--border)", display: "flex", justifyContent: "space-between" }}><span>{l.user} · {l.ip}</span><Badge color={l.outcome === "Success" ? "var(--ok)" : "var(--danger)"}>{l.outcome}</Badge><span style={{ color: "var(--text-dim)" }}>{l.ts}</span></div>)}
          {loginAudit.length === 0 && <div className="hint">No login events recorded yet.</div>}
        </div>
      </div>
      )}
      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreate={onCreateUser} authUser={authUser} missions={missions} />}
    </>
  );
}

function CreateUserModal({ onClose, onCreate, authUser, missions, presetRole, presetMissionId }) {
  const isSystemOwner = authUser?.role === "System Owner";
  const roleOptions = isSystemOwner
    ? ["Head Office Admin", "Mission Admin", "Custodian"]
    : ["Custodian"];
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(presetRole || roleOptions[0]);
  const [missionId, setMissionId] = useState(presetMissionId || missions[0]?.id || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const needsMission = isSystemOwner ? role !== "Head Office Admin" : true;
  const isCustodian = role === "Custodian";

  async function submit() {
    if (!fullName) { setError("Full name is required."); return; }
    if (!isCustodian) {
      if (!email || !password) { setError("Email and password are required for this role."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    }
    if (needsMission && isSystemOwner && !missionId) { setError("This role requires a mission to be assigned."); return; }
    setSaving(true);
    const res = await onCreate(fullName, isCustodian ? null : email, isCustodian ? null : password, role, isSystemOwner ? (needsMission ? missionId : null) : undefined);
    setSaving(false);
    if (res?.error) { setError(res.error); return; }
    onClose();
  }

  return (
    <Modal onClose={onClose} width={440}>
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2>{isCustodian ? "Add Custodian" : "Create User"}</h2><X size={18} style={{ cursor: "pointer" }} onClick={onClose} /></div>
      <div className="hint" style={{ marginBottom: 14 }}>{isCustodian ? "Custodians are employee records for asset assignment — they don't get a system login." : `New accounts start as "Pending Vetting" — confirm security clearance afterwards to activate the login.`} {!isSystemOwner && "This will be added to your own mission."}</div>
      {error && <div className="error-banner">{error}</div>}
      <Field label="Full Name"><input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. J. Smith" /></Field>
      {!isCustodian && (<>
        <Field label="Email"><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@dirco.gov.za" /></Field>
        <Field label="Temporary Password"><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" /></Field>
      </>)}
      <Field label="Role"><select value={role} onChange={e => setRole(e.target.value)}>{roleOptions.map(r => <option key={r}>{r}</option>)}</select></Field>
      {isSystemOwner && needsMission && (
        <Field label="Mission"><select value={missionId} onChange={e => setMissionId(e.target.value)}>{missions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn accent" onClick={submit} disabled={saving}>{saving ? "Creating…" : "Create User"}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/* =====================================================================
   TRAINING
===================================================================== */
function TrainingView({ training, onSetStatus }) {
  return (
    <div className="card">
      <h3><GraduationCap size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Skills Transfer Plan <InfoTip title="Skills Transfer Plan">Tracks the handover of system knowledge from the implementation team to DIRCO's own staff, per the TOR's training requirement. <b>Sign-off</b> (the green check) confirms a module was completed and the trainee is confident using that part of the system independently.</InfoTip></h3>
      <div className="hint">Structured training for Asset Management, ICT and end-user teams, with sign-off tracking.</div>
      <table><thead><tr><th>Module</th><th>Audience</th><th>Trainee</th><th>Status</th><th>Sign-off</th><th /></tr></thead>
        <tbody>{training.map(t => (<tr key={t.id}><td>{t.module}</td><td>{t.audience}</td><td>{t.trainee}</td>
          <td><Badge color={t.status === "Completed" ? "var(--ok)" : t.status === "Scheduled" ? "var(--warn)" : "var(--muted)"}>{t.status}</Badge></td>
          <td>{t.signedOff ? <CheckCircle2 size={15} color="var(--ok)" /> : "—"}</td>
          <td>{t.status !== "Completed" && <button className="btn ghost" onClick={() => onSetStatus(t.id, t.status === "Not Started" ? "Scheduled" : "Completed")}>{t.status === "Not Started" ? "Schedule" : "Mark Complete"}</button>}</td></tr>))}</tbody></table>
    </div>
  );
}

/* =====================================================================
   SYSTEM ADMIN
===================================================================== */
/* =====================================================================
   BRANDING
===================================================================== */
function BrandingView({ theme, setTheme, orgName, setOrgName, logo, onUploadClick, onRemoveLogo }) {
  const [nameDraft, setNameDraft] = useState(orgName);
  useEffect(() => setNameDraft(orgName), [orgName]);
  return (
    <div className="grid-2">
      <div className="card">
        <h3>Organisation Identity <InfoTip title="White-Label Branding">This is what makes the platform "white-label" — the same codebase can be re-skinned for a different client by swapping the logo, name, and colour theme here, without touching any code. Changes apply instantly across the whole app (sidebar, buttons, badges) and are saved to the database immediately.</InfoTip></h3><div className="hint">This is what changes when the platform is deployed for a new client. Saved to Postgres immediately.</div>
        <Field label="Organisation / Client Name"><input value={nameDraft} onChange={e => setNameDraft(e.target.value)} onBlur={() => setOrgName(nameDraft)} /></Field>
        <Field label="Logo">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 56, height: 56, borderRadius: 10, border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "#fafbfd" }}>
              {logo ? <img src={logo} style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <Building2 size={22} color="var(--text-dim)" />}
            </div>
            <button className="btn ghost" onClick={onUploadClick}><Upload size={14} /> Upload logo</button>
            {logo && <button className="btn ghost" onClick={onRemoveLogo}>Remove</button>}
          </div>
        </Field>
        <h3 style={{ marginTop: 20 }}>Theme Presets</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {PRESETS.map(p => (<div key={p.name} className={"preset-card" + (p.name === theme.name ? " active" : "")} onClick={() => setTheme(p)}>
            <div className="preset-dots"><span style={{ background: p.primary }} /><span style={{ background: p.accent }} /><span style={{ background: p.secondary }} /></div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.name}</div></div>))}
        </div>
        <h3 style={{ marginTop: 20 }}>Custom Colours</h3>
        {[["Primary", "primary"], ["Accent", "accent"], ["Secondary", "secondary"]].map(([label, key]) => (
          <div className="color-row" key={key}>
            <label style={{ width: 90, fontSize: 12.5, color: "var(--text-dim)" }}>{label}</label>
            <input type="color" value={theme[key]} onChange={e => setTheme({ ...theme, name: "Custom", [key]: e.target.value })} />
            <span style={{ fontSize: 12, fontFamily: "ui-monospace,monospace" }}>{theme[key]}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Live Preview</h3><div className="hint">Sidebar, buttons and badges update instantly across the whole app.</div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ background: theme.primary, padding: 14, display: "flex", alignItems: "center", gap: 10 }}>
            {logo ? <img src={logo} style={{ width: 26, height: 26, borderRadius: 6, background: "#fff", objectFit: "contain" }} /> : <div style={{ width: 26, height: 26, borderRadius: 6, background: theme.accent }} />}
            <span style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{orgName}</span>
          </div>
          <div style={{ padding: 14 }}><button className="btn accent" style={{ marginBottom: 8 }}>Primary Action</button><br /><Badge color={theme.accent}>In Use</Badge> <Badge color={theme.secondary}>Pending</Badge></div>
        </div>
      </div>
    </div>
  );
}

/* =====================================================================
   GLOBAL STYLE
===================================================================== */
function GlobalStyle() {
  return (
    <style>{`
      .ams-root { --bg: #F4F6F9; --panel: #FFFFFF; --border: #E3E7EE; --text: #1A2233; --text-dim: #667085;
        font-family: ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; display: flex; font-variant-numeric: tabular-nums; }
      .ams-root * { box-sizing: border-box; }
      .sidebar { width: 240px; flex-shrink: 0; background: var(--primary); color: #fff; display: flex; flex-direction: column; padding: 20px 14px; gap: 2px; height: 100%; overflow-y: auto; }
      .brand { display:flex; align-items:center; gap:10px; padding: 6px 8px 20px 8px; }
      .brand img { width: 34px; height: 34px; object-fit: contain; border-radius: 6px; background:#fff; }
      .brand .logo-fallback { width: 34px; height: 34px; border-radius: 8px; background: var(--accent); display:flex; align-items:center; justify-content:center; font-weight:800; font-size: 14px; }
      .brand .name { font-weight: 700; font-size: 15px; } .brand .sub { font-size: 10.5px; opacity: 0.65; margin-top: 1px; }
      .navitem { display:flex; align-items:center; gap: 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; cursor: pointer; color: rgba(255,255,255,0.78); transition: all .15s; }
      .navitem:hover { background: rgba(255,255,255,0.08); color: #fff; }
      .navitem.active { background: rgba(255,255,255,0.14); color: #fff; font-weight: 600; }
      .nav-badge { margin-left: auto; background: var(--danger); color: #fff; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; }
      .navlabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.45; margin: 12px 10px 3px; }
      .main { flex: 1; min-width: 0; height: 100%; display:flex; flex-direction:column; overflow: hidden; }
      .topbar { height: 58px; background: var(--panel); border-bottom: 1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding: 0 24px; flex-shrink:0; }
      .topbar h1 { font-size: 16px; font-weight: 700; margin:0; }
      .live-pill { display:flex; align-items:center; gap:6px; font-size: 11px; color: var(--text-dim); font-weight: 600; }
      .live-pill .dot { width:7px; height:7px; border-radius:50%; background: var(--ok); box-shadow: 0 0 0 3px rgba(46,158,91,0.15); }
      .content { padding: 22px; flex: 1; min-height: 0; overflow-y: auto; }
      .kpi-grid { display:grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 18px; }
      .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
      .kpi .label { font-size: 11.5px; color: var(--text-dim); font-weight: 600; text-transform:uppercase; letter-spacing:.04em; }
      .kpi .value { font-size: 24px; font-weight: 800; margin-top: 6px; }
      .kpi .delta { font-size: 11.5px; margin-top: 4px; display:flex; align-items:center; gap:4px; }
      .grid-2 { display:grid; grid-template-columns: 1.4fr 1fr; gap: 14px; margin-bottom: 14px; }
      .grid-3 { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 14px; }
      .quick-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .qa-btn { display: flex; flex-direction: column; align-items: center; gap: 6px; background: #FAFBFD; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; font-size: 11.5px; font-weight: 600; color: var(--text); cursor: pointer; min-width: 96px; flex: 1; }
      .qa-btn:hover { background: #F0F3F7; border-color: var(--accent); }
      .qa-btn svg { color: var(--accent); }
      .alert-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 12.5px; cursor: pointer; }
      .alert-row span { flex: 1; }
      .alert-row b { font-size: 13px; }
      .alert-row:hover { background: #FAFBFD; }
      .card h3 { margin:0 0 4px; font-size: 13.5px; font-weight:700; }
      .card .hint { font-size: 11.5px; color: var(--text-dim); margin-bottom: 10px; }
      table { width:100%; border-collapse: collapse; font-size: 12.5px; }
      th { text-align:left; font-size: 10.5px; text-transform:uppercase; letter-spacing:.05em; color: var(--text-dim); padding: 7px 9px; border-bottom: 1px solid var(--border); }
      td { padding: 9px 9px; border-bottom: 1px solid var(--border); vertical-align: middle; }
      tr.row:hover { background: #FAFBFD; cursor:pointer; }
      .badge { display:inline-flex; align-items:center; gap:5px; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
      .toolbar { display:flex; gap:10px; align-items:center; margin-bottom: 14px; flex-wrap: wrap; }
      .search { display:flex; align-items:center; gap:8px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; flex:1; max-width: 340px; }
      .search input { border:none; outline:none; font-size: 12.5px; width:100%; }
      select { border:1px solid var(--border); border-radius:8px; padding: 8px 10px; font-size:12.5px; background:#fff; }
      .btn { display:inline-flex; align-items:center; gap:6px; background: var(--primary); color:#fff; border:none; border-radius: 8px; padding: 8px 14px; font-size: 12.5px; font-weight:600; cursor:pointer; }
      .btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .btn.accent { background: var(--accent); }
      .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
      .progress-bar { height: 7px; background: #EEF1F5; border-radius: 999px; overflow:hidden; }
      .progress-fill { height: 100%; border-radius: 999px; }
      .modal-backdrop { position:fixed; inset:0; background: rgba(15,20,30,0.45); display:flex; align-items:center; justify-content:center; z-index: 50; }
      .modal { background:#fff; border-radius: 14px; max-width: 92vw; max-height: 88vh; overflow-y:auto; padding: 22px 24px; }
      .modal h2 { margin: 0 0 4px; font-size: 16.5px; }
      .field { margin-bottom: 12px; }
      .field label { display:block; font-size: 11.5px; font-weight:600; color: var(--text-dim); margin-bottom: 5px; }
      .field input, .field select { width:100%; border:1px solid var(--border); border-radius: 8px; padding: 9px 10px; font-size: 12.5px; }
      .row2 { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .preset-card { border:1px solid var(--border); border-radius: 10px; padding: 10px; cursor:pointer; display:flex; align-items:center; gap:10px; }
      .preset-card.active { border-color: var(--primary); background: #F7F9FC; }
      .preset-dots { display:flex; gap: 4px; } .preset-dots span { width: 14px; height:14px; border-radius: 4px; display:block; }
      .color-row { display:flex; align-items:center; gap: 10px; margin-bottom: 12px; }
      .detail-panel { padding: 4px 0; }
      .kv { display:flex; justify-content:space-between; padding: 7px 0; border-bottom: 1px dashed var(--border); font-size: 12.5px; }
      .tabs { display:flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 14px 0; flex-wrap: wrap; }
      .tab { font-size: 12px; padding: 7px 10px; cursor:pointer; color: var(--text-dim); border-bottom: 2px solid transparent; }
      .tab.active { color: var(--primary); border-bottom-color: var(--accent); font-weight: 700; }
      .inline-form { background: #FAFBFD; border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-top: 8px; }
      .section-title { font-size: 11.5px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: .04em; margin: 12px 0 6px; }
      .error-banner { background: #FCEBEA; color: var(--danger); border: 1px solid #F3C9C6; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 12px; }
      .infotip-wrap { position: relative; display: inline-flex; vertical-align: middle; margin-left: 6px; }
      .infotip-btn { width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--border); background: #F4F6F9; color: var(--text-dim); display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; flex-shrink: 0; }
      .infotip-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
      .infotip-backdrop { position: fixed; inset: 0; z-index: 60; }
      .infotip-panel { position: absolute; top: 22px; left: 0; z-index: 61; width: 300px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(20,30,50,0.14); padding: 12px 14px; text-align: left; }
      .infotip-head { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; font-weight: 700; color: var(--primary); margin-bottom: 6px; }
      .infotip-body { font-size: 12px; color: var(--text-dim); line-height: 1.5; font-weight: 400; }
      .infotip-body b { color: var(--text); }
      .infotip-body ul { margin: 4px 0 0; padding-left: 16px; }
      .infotip-body li { margin-bottom: 4px; }
      .lightbox-backdrop { position: fixed; inset: 0; background: rgba(10,14,22,0.88); z-index: 200; display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
      .lightbox-img { max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
      .bell-badge { position: absolute; top: -6px; right: -8px; background: var(--danger); color: #fff; font-size: 9.5px; font-weight: 700; padding: 1px 4px; border-radius: 999px; min-width: 15px; text-align: center; line-height: 1.4; }
      .notif-panel { position: absolute; top: 26px; right: 0; z-index: 61; width: 300px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(20,30,50,0.14); overflow: hidden; }
      .notif-head { padding: 10px 12px; font-size: 12.5px; font-weight: 700; border-bottom: 1px solid var(--border); }
      .notif-item { padding: 9px 12px; border-bottom: 1px dashed var(--border); cursor: pointer; }
      .notif-item:hover { background: #FAFBFD; }
      .notif-footer { padding: 9px 12px; text-align: center; font-size: 12px; font-weight: 600; color: var(--accent); cursor: pointer; border-top: 1px solid var(--border); }
      .row-menu-btn { background: transparent; border: none; cursor: pointer; padding: 4px; border-radius: 6px; color: var(--text-dim); display: flex; }
      .row-menu-btn:hover { background: #EEF1F5; }
      .row-menu-panel { position: absolute; top: 24px; right: 0; z-index: 61; width: 220px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(20,30,50,0.14); overflow: hidden; padding: 4px; }
      .row-menu-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12.5px; border-radius: 6px; cursor: pointer; }
      .row-menu-item:hover { background: #F4F6F9; }
      .spin { animation: ams-spin 0.8s linear infinite; }
      @keyframes ams-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `}</style>
  );
}
