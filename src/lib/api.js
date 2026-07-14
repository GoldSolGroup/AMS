const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const TOKEN_KEY = "ams_token";

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token) { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); }

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function req(method, path, body) {
  const token = getToken();
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    setToken(null);
    onUnauthorized();
    throw new Error("Session expired — please log in again.");
  }
  if (!res.ok) {
    let detail;
    try { detail = (await res.json()).detail; } catch { detail = res.statusText; }
    if (res.status === 409 && detail?.duplicate) {
      const err = new Error("duplicate");
      err.duplicate = detail.duplicate;
      throw err;
    }
    throw new Error(typeof detail === "string" ? detail : `${method} ${path} failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}
const get = (path) => req("GET", path);

/* ---------------------------- Auth ---------------------------- */
export async function login(email, password) {
  const data = await req("POST", "/auth/login", { email, password });
  setToken(data.token);
  return data.user;
}
export async function logout() {
  try { await req("POST", "/auth/logout"); } catch { /* ignore */ }
  setToken(null);
}
export async function me() { return get("/auth/me"); }
export async function createUser(tenantId, fullName, email, password, role, missionId) {
  return req("POST", `/team?tenant_id=${tenantId}`, { fullName, email, password, role, missionId });
}
export async function getAsset(assetId) { return get(`/assets/${assetId}`); }
export async function deleteTeamMember(id) { return req("DELETE", `/team/${id}`); }

/* ---------------------------- Approvals ---------------------------- */
export async function requestAssetAction(tenantId, assetId, type, payload, reason) {
  return req("POST", `/assets/${assetId}/action-requests?tenant_id=${tenantId}`, { type, payload, reason });
}
export async function getActionRequests(tenantId, status) {
  return get(`/action-requests?tenant_id=${tenantId}${status ? `&status=${status}` : ""}`);
}
export async function approveActionRequest(id, note) { return req("POST", `/action-requests/${id}/approve`, { note }); }
export async function rejectActionRequest(id, note) { return req("POST", `/action-requests/${id}/reject`, { note }); }

/* ---------------------------- Tenant / Branding ---------------------------- */
export async function getOrCreateTenant() { return get("/tenant"); }
export async function updateTenant(id, fields) { return req("PATCH", `/tenant/${id}`, fields); }

/* ---------------------------- Missions ---------------------------- */
export async function getMissions(tenantId) { return get(`/missions?tenant_id=${tenantId}`); }
export async function createMission(tenantId, name, region) { return req("POST", `/missions?tenant_id=${tenantId}`, { name, region }); }
export async function updateMission(id, fields) { return req("PATCH", `/missions/${id}`, fields); }

/* ---------------------------- Asset Classes ---------------------------- */
export async function getClasses(tenantId) { return get(`/classes?tenant_id=${tenantId}`); }
export async function addClass(tenantId, name, type, usefulLifeYears) { return req("POST", `/classes?tenant_id=${tenantId}`, { name, type, usefulLifeYears }); }
export async function setClassActive(id, active) { return req("PATCH", `/classes/${id}`, { active }); }
export async function setClassUsefulLife(id, usefulLifeYears) { return req("PATCH", `/classes/${id}`, { usefulLifeYears }); }

/* ---------------------------- Assets ---------------------------- */
export async function getAssetsFull(tenantId) { return get(`/assets?tenant_id=${tenantId}`); }
export async function addAsset(tenantId, form) {
  try {
    return await req("POST", `/assets?tenant_id=${tenantId}`, form);
  } catch (err) {
    if (err.duplicate) return { __duplicate: err.duplicate };
    throw err;
  }
}
export async function updateAsset(id, fields) { return req("PATCH", `/assets/${id}`, fields); }
export async function addAssetHistory(assetId, type, note, actor) { return req("POST", `/assets/${assetId}/history`, { type, note, actor }); }
export async function addAssetPhoto(assetId, url) { return req("POST", `/assets/${assetId}/photos`, { url }); }
export async function addAssetDocument(assetId, name, url = null) { return req("POST", `/assets/${assetId}/documents`, { name, url }); }
export async function requestDisposal(assetId, { method, reason, value }) { return req("POST", `/assets/${assetId}/disposal`, { method, reason, value }); }
export async function approveDisposal(assetId) { return req("POST", `/assets/${assetId}/disposal/approve`); }
export async function rejectDisposal(assetId, note) { return req("POST", `/assets/${assetId}/disposal/reject`, { note }); }
export async function applyFairValue(assetId, value, justification, actor) { return req("POST", `/assets/${assetId}/fair-value`, { value: Number(value), justification, actor }); }
export async function mergeAssets(keepId, removeIds, actor) { return req("POST", "/assets/merge", { keepId, removeIds, actor }); }

/* ---------------------------- WIP ---------------------------- */
export async function getWipFull(tenantId) { return get(`/wip?tenant_id=${tenantId}`); }
export async function addWipInvoice(projectId, ref, amount) { return req("POST", `/wip/${projectId}/invoices`, { ref, amount: Number(amount) }); }
export async function addWipRetention(projectId, pct, surety) { return req("POST", `/wip/${projectId}/retentions`, { pct: Number(pct), surety }); }
export async function addWipCession(projectId, beneficiary, amount) { return req("POST", `/wip/${projectId}/cessions`, { beneficiary, amount: Number(amount) }); }
export async function addWipBoq(projectId, item, amount) { return req("POST", `/wip/${projectId}/boq`, { item, amount: Number(amount) }); }
export async function capitaliseWip(tenantId, projectId, lines, defaults) {
  return req("POST", `/wip/${projectId}/capitalise?tenant_id=${tenantId}`, {
    lines: lines.map(l => ({ desc: l.desc, value: Number(l.value) || 0 })),
    location: defaults.location,
  });
}

/* ---------------------------- Verification ---------------------------- */
export async function getCyclesFull(tenantId) { return get(`/cycles?tenant_id=${tenantId}`); }
export async function planCycle(tenantId, scope, dueDate, assetIds) { return req("POST", `/cycles?tenant_id=${tenantId}`, { scope, due: dueDate, assetIds }); }
export async function scanAssetIntoCycle(cycleId, assetId, verifiedBy) { return req("POST", `/cycles/${cycleId}/scan`, { assetId, verifiedBy }); }
export async function closeCycle(cycleId, missingAssetIds) { return req("POST", `/cycles/${cycleId}/close`, { missingAssetIds }); }

/* ---------------------------- Maintenance ---------------------------- */
export async function getMaintenance(tenantId) { return get(`/maintenance?tenant_id=${tenantId}`); }
export async function addMaintenance(tenantId, assetId, description, dueDate) { return req("POST", `/maintenance?tenant_id=${tenantId}`, { assetId, desc: description, due: dueDate }); }
export async function setMaintenanceStatus(id, status) { return req("PATCH", `/maintenance/${id}`, { status }); }

/* ---------------------------- Quarterly Compliance ---------------------------- */
export async function getCorrectionJournals(tenantId) { return get(`/correction-journals?tenant_id=${tenantId}`); }
export async function addCorrectionJournal(tenantId, assetId, reason, evidence, approver) { return req("POST", `/correction-journals?tenant_id=${tenantId}`, { assetId, reason, evidence, approver }); }

/* ---------------------------- Training ---------------------------- */
export async function getTraining(tenantId) { return get(`/training?tenant_id=${tenantId}`); }
export async function setTrainingStatus(id, status) { return req("PATCH", `/training/${id}`, { status }); }

/* ---------------------------- System Admin ---------------------------- */
export async function getTickets(tenantId) { return get(`/tickets?tenant_id=${tenantId}`); }
export async function addTicket(tenantId, subject, priority, sla) { return req("POST", `/tickets?tenant_id=${tenantId}`, { subject, priority, sla }); }
export async function advanceTicket(id, status) { return req("PATCH", `/tickets/${id}`, { status }); }
export async function getMilestones(tenantId) { return get(`/milestones?tenant_id=${tenantId}`); }
export async function setMilestoneStatus(id, status) { return req("PATCH", `/milestones/${id}`, { status }); }
export async function getGlMapping(tenantId) { return get(`/gl-mapping?tenant_id=${tenantId}`); }
export async function updateGlCode(id, glCode) { return req("PATCH", `/gl-mapping/${id}`, { glCode }); }
export async function recordMigrationRun(tenantId, legacyCount, legacyValue, migratedCount, migratedValue) {
  return req("POST", `/migration-runs?tenant_id=${tenantId}`, { legacyCount, legacyValue, migratedCount, migratedValue });
}

/* ---------------------------- Security ---------------------------- */
export async function getTeam(tenantId) { return get(`/team?tenant_id=${tenantId}`); }
export async function setTeamStatus(id, status) { return req("PATCH", `/team/${id}`, { status }); }
export async function setTeamRole(id, role) { return req("PATCH", `/team/${id}`, { role }); }
export async function confirmVetting(id) { return req("POST", `/team/${id}/confirm-vetting`); }
export async function getPasswordPolicy(tenantId) { return get(`/password-policy?tenant_id=${tenantId}`); }
export async function updatePasswordPolicy(tenantId, fields) {
  return req("PUT", `/password-policy?tenant_id=${tenantId}`, {
    minLength: fields.min_length, complexity: fields.complexity, expiryDays: fields.expiry_days, historyCount: fields.history_count,
  });
}
export async function getLoginAudit(tenantId) { return get(`/login-audit?tenant_id=${tenantId}`); }

/* ---------------------------- Activity Feed ---------------------------- */
export async function getActivity(tenantId) { return get(`/activity?tenant_id=${tenantId}`); }
export async function logActivity(tenantId, message) { return req("POST", `/activity?tenant_id=${tenantId}`, { message }); }
