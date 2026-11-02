/**
 * Public REST API v1 (API-key auth). Lets any tool read and write CRM objects.
 *   GET    /v1/objects/:type?unit=res|com&limit=100&after=<id>
 *   GET    /v1/objects/:type/:id
 *   POST   /v1/objects/:type            { unit, properties: {...} }
 *   PATCH  /v1/objects/:type/:id        { properties: {...} }
 *   DELETE /v1/objects/:type/:id
 *   GET    /v1/search?q=...
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireApiKey } = require("../lib/auth");
const { putRecord, deleteRecord, getRecord, newId, applySync } = require("../lib/records");

const r = express.Router();
const API_TYPES = ["contacts", "companies", "deals", "tickets", "tasks", "properties", "campaigns", "emails", "forms", "pages", "events", "acts"];
r.use(rateLimit({ windowMs: 10 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.get("Authorization") || req.ip, message: { error: "Rate limit: 100 requests per 10 seconds." } }));
r.use(requireApiKey);

const DEFAULTS = {
  contacts: () => ({ first: "", last: "", email: "—", phone: "—", title: "", company: null, lifecycle: "Lead", status: "New", owner: "", source: "API", score: 50, lastAct: Date.now(), created: Date.now(), type: "Buyer", budget: 0, area: "" }),
  companies: () => ({ name: "", domain: "—", industry: "", city: "", employees: 0, owner: "", lifecycle: "Lead", phone: "", created: Date.now(), expiry: null, sf: 0 }),
  deals: () => ({ name: "", pipe: "buy", stage: "appt", amount: 0, close: Date.now() + 30 * 864e5, owner: "", contacts: [], company: null, prop: null, created: Date.now(), priority: "Medium", dtype: "New business" }),
  tickets: () => ({ subject: "", desc: "", status: "new", priority: "Medium", cat: "", contact: null, company: null, owner: "", source: "API", created: Date.now() }),
  tasks: () => ({ title: "", due: Date.now() + 864e5, kind: "To-do", ref: null, done: false, owner: "" }),
};
const checkType = (req, res, next) => (API_TYPES.includes(req.params.type) ? next() : res.status(404).json({ error: `Unknown object type. Use one of: ${API_TYPES.join(", ")}` }));
const out = (row) => ({ id: row.data.id, unit: row.unit, properties: row.data });

r.get("/objects/:type", checkType, async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const q = db("records").where({ org_id: req.orgId, type: req.params.type, deleted: false }).orderBy("id").limit(limit + 1);
  if (["res", "com"].includes(req.query.unit)) q.andWhere({ unit: req.query.unit });
  if (req.query.after) q.andWhere("id", ">", String(req.query.after));
  if (req.query.email && req.params.type === "contacts") q.andWhere({ email: String(req.query.email).toLowerCase() });
  const rows = await q;
  res.json({ results: rows.slice(0, limit).map(out), paging: rows.length > limit ? { next: { after: rows[limit - 1].id } } : null });
});

r.get("/objects/:type/:id", checkType, async (req, res) => {
  const row = await db("records").where({ org_id: req.orgId, type: req.params.type, id: req.params.id, deleted: false }).first();
  row ? res.json(out(row)) : res.status(404).json({ error: "Not found" });
});

r.post("/objects/:type", checkType, async (req, res) => {
  const unit = req.body?.unit === "com" ? "com" : "res";
  const props = req.body?.properties || {};
  if (typeof props !== "object") return res.status(400).json({ error: "Send { unit, properties: {...} }." });
  const data = { ...(DEFAULTS[req.params.type]?.() || {}), ...props, id: props.id && /^[A-Za-z0-9]{1,40}$/.test(props.id) ? props.id : newId() };
  await applySync(req.orgId, "api", { [unit]: { [req.params.type]: { upsert: [data] } } });
  res.status(201).json({ id: data.id, unit, properties: data });
});

r.patch("/objects/:type/:id", checkType, async (req, res) => {
  const row = await db("records").where({ org_id: req.orgId, type: req.params.type, id: req.params.id, deleted: false }).first();
  if (!row) return res.status(404).json({ error: "Not found" });
  const data = { ...row.data, ...(req.body?.properties || {}), id: row.data.id };
  await applySync(req.orgId, "api", { [row.unit]: { [req.params.type]: { upsert: [data] } } });
  res.json({ id: data.id, unit: row.unit, properties: data });
});

r.delete("/objects/:type/:id", checkType, async (req, res) => {
  await deleteRecord(req.orgId, req.params.type, req.params.id, { by: "api" });
  res.status(204).end();
});

r.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters." });
  const rows = await db("records").where({ org_id: req.orgId, deleted: false }).whereIn("type", ["contacts", "companies", "deals", "tickets"])
    .andWhereRaw("data::text ilike ?", [`%${q.replace(/[%_]/g, "")}%`]).limit(50);
  res.json({ results: rows.map((r) => ({ type: r.type, ...out(r) })) });
});

module.exports = r;
