const db = require("../db");
const { shortId } = require("./crypto");
const { emit } = require("./webhooks");

const TYPES = ["contacts", "companies", "deals", "tickets", "properties", "tasks", "acts", "campaigns", "emails", "forms", "pages", "mail", "events"];
const UNITS = ["res", "com"];
const LIFECYCLE = ["Subscriber", "Lead", "Marketing qualified lead", "Sales qualified lead", "Opportunity", "Customer", "Evangelist", "Other"];
const newId = () => shortId();

function rowFor(orgId, unit, type, data, by, extKey) {
  return {
    id: String(data.id),
    org_id: orgId,
    unit,
    type,
    data,
    email: type === "contacts" && data.email && data.email !== "—" ? String(data.email).toLowerCase() : null,
    ext_key: extKey || data.ext?.key || null,
    deleted: false,
    updated_ms: Date.now(),
    updated_by: by || "server",
  };
}

async function putRecord(orgId, unit, type, data, { by = "server", extKey, trx } = {}) {
  if (!TYPES.includes(type)) throw new Error("Unknown record type " + type);
  if (!data.id) data.id = newId();
  const row = rowFor(orgId, unit, type, data, by, extKey);
  await (trx || db)("records").insert(row).onConflict(["org_id", "type", "id"]).merge();
  return data;
}

async function deleteRecord(orgId, type, id, { by = "server", trx } = {}) {
  await (trx || db)("records").where({ org_id: orgId, type, id }).update({ deleted: true, updated_ms: Date.now(), updated_by: by });
}

async function getRecord(orgId, type, id) {
  const r = await db("records").where({ org_id: orgId, type, id, deleted: false }).first();
  return r ? { ...r.data, _unit: r.unit } : null;
}

async function listRecords(orgId, { unit, type } = {}) {
  const q = db("records").where({ org_id: orgId, deleted: false });
  if (unit) q.andWhere({ unit });
  if (type) q.andWhere({ type });
  return (await q.select("unit", "type", "data")).map((r) => ({ ...r.data, _unit: r.unit, _type: r.type }));
}

async function findByExt(orgId, type, extKey) {
  const r = await db("records").where({ org_id: orgId, type, ext_key: extKey }).first();
  return r ? { unit: r.unit, data: r.data, deleted: r.deleted } : null;
}

async function findContactByEmail(orgId, email) {
  if (!email) return null;
  const r = await db("records").where({ org_id: orgId, type: "contacts", email: String(email).toLowerCase(), deleted: false }).first();
  return r ? { unit: r.unit, data: r.data } : null;
}

/** Log activity on records, bumping the contacts' last-activity time like the app does. */
async function addActivity(orgId, unit, { kind, title, body = "", refs = {}, extra = {} }) {
  const r = { contact: [], company: [], deal: [], ticket: [], ...refs };
  for (const cid of r.contact) {
    const c = await getRecord(orgId, "contacts", cid);
    if (!c) continue;
    if (c.company && !r.company.includes(c.company)) r.company.push(c.company);
    const { _unit, ...clean } = c;
    clean.lastAct = Date.now();
    await putRecord(orgId, _unit, "contacts", clean);
  }
  const act = { id: newId(), kind, ts: extra.ts || Date.now(), title, body, refs: r, ...extra };
  await putRecord(orgId, unit, "acts", act);
  return act;
}

/** Find a contact by email or create one. Returns { contact, unit, created }. */
async function upsertContact(orgId, unit, f, { owner, source = "Website", lifecycle = "Lead" } = {}) {
  const existing = f.email ? await findContactByEmail(orgId, f.email) : null;
  if (existing) {
    const c = existing.data;
    let dirty = false;
    for (const k of ["phone", "title"]) if (f[k] && (!c[k] || c[k] === "—")) { c[k] = f[k]; dirty = true; }
    if (dirty) await putRecord(orgId, existing.unit, "contacts", c);
    return { contact: c, unit: existing.unit, created: false };
  }
  const name = String(f.name || "").trim();
  const c = {
    id: newId(),
    first: f.first || name.split(/\s+/)[0] || "Unknown",
    last: f.last || name.split(/\s+/).slice(1).join(" "),
    email: f.email || "—",
    phone: f.phone || "—",
    title: f.title || "",
    company: f.company || null,
    lifecycle: LIFECYCLE.includes(lifecycle) ? lifecycle : "Lead",
    status: "New",
    owner: owner || "",
    source,
    score: f.score || 55,
    lastAct: Date.now(),
    created: Date.now(),
    type: f.type || (unit === "com" ? "Tenant" : "Buyer"),
    budget: Number(f.budget) || 0,
    area: f.area || "",
  };
  await putRecord(orgId, unit, "contacts", c);
  emit(orgId, "contact.created", { unit, contact: c });
  return { contact: c, unit, created: true };
}

/**
 * Apply a batch of client changes: { [unit]: { [type]: { upsert: [...], delete: [ids] } } }.
 * Emits webhook events by comparing with the stored version.
 */
async function applySync(orgId, clientId, changes, hooks = {}) {
  const applied = { upserts: 0, deletes: 0 };
  const events = [];
  await db.transaction(async (trx) => {
    for (const unit of Object.keys(changes || {})) {
      if (!UNITS.includes(unit)) continue;
      for (const type of Object.keys(changes[unit] || {})) {
        if (!TYPES.includes(type)) continue;
        const { upsert = [], delete: dels = [] } = changes[unit][type] || {};
        if (upsert.length) {
          const ids = upsert.map((r) => String(r.id));
          const prev = await trx("records").where({ org_id: orgId, type }).whereIn("id", ids).select("id", "data", "deleted");
          const prevMap = new Map(prev.map((p) => [p.id, p.deleted ? null : p.data]));
          for (const data of upsert) {
            if (!data || typeof data !== "object" || !data.id || String(data.id).length > 64) continue;
            const before = prevMap.get(String(data.id));
            await putRecord(orgId, unit, type, data, { by: clientId, trx });
            applied.upserts++;
            events.push(...diffEvents(unit, type, before, data));
          }
        }
        for (const id of dels) {
          const before = await trx("records").where({ org_id: orgId, type, id: String(id) }).first();
          await deleteRecord(orgId, type, String(id), { by: clientId, trx });
          applied.deletes++;
          if (before && hooks.onDelete) hooks.onDelete(unit, type, before.data);
        }
      }
    }
  });
  for (const e of events) emit(orgId, e.event, e.payload);
  return applied;
}

function diffEvents(unit, type, before, after) {
  const out = [];
  const one = (event, payload) => out.push({ event, payload: { unit, ...payload } });
  if (type === "contacts") before ? one("contact.updated", { contact: after }) : one("contact.created", { contact: after });
  if (type === "companies" && !before) one("company.created", { company: after });
  if (type === "deals") {
    if (!before) one("deal.created", { deal: after });
    else if (before.stage !== after.stage) {
      one("deal.stage_changed", { deal: after, from: before.stage, to: after.stage });
      if (after.stage === "won") one("deal.won", { deal: after });
    }
  }
  if (type === "tickets") {
    if (!before) one("ticket.created", { ticket: after });
    else if (before.status !== after.status) one("ticket.status_changed", { ticket: after, from: before.status, to: after.status });
  }
  if (type === "events" && !before) one("meeting.booked", { meeting: after });
  return out;
}

module.exports = { TYPES, UNITS, newId, putRecord, deleteRecord, getRecord, listRecords, findByExt, findContactByEmail, addActivity, upsertContact, applySync };
