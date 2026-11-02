/** Unauthenticated endpoints used by published landing pages, email recipients and providers. */
const express = require("express");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { config } = require("../config");
const { getRecord, putRecord, upsertContact, addActivity, newId } = require("../lib/records");
const { emit } = require("../lib/webhooks");
const { esc } = require("../lib/render");
const sendgrid = require("../services/sendgrid");
const zillow = require("../services/zillow");
const docusign = require("../services/docusign");
const { decryptJson, safeEqual } = require("../lib/crypto");

const r = express.Router();
const cors = (req, res, next) => { res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); if (req.method === "OPTIONS") return res.status(204).end(); next(); };
const formLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many submissions. Please wait a minute." } });
const orgByPublic = (id) => db("orgs").where({ public_id: String(id) }).first();

/* ---------- landing-page forms ---------- */
r.options("/public/*", cors);
r.post("/public/forms/:org/:formId", cors, formLimiter, express.json({ limit: "64kb" }), async (req, res) => {
  const org = await orgByPublic(req.params.org);
  if (!org) return res.status(404).json({ error: "Form not found." });
  const form = await getRecord(org.id, "forms", req.params.formId);
  if (!form) return res.status(404).json({ error: "Form not found." });
  const body = req.body || {};
  if (body._hp) return res.json({ ok: true }); // honeypot: silently drop bots
  const unit = form._unit;
  const vals = {};
  for (const f of form.fields || []) {
    const v = String(body[f.label] ?? "").trim().slice(0, 2000);
    if (f.required && f.type !== "checkbox" && !v) return res.status(400).json({ error: `${f.label} is required.` });
    if (f.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return res.status(400).json({ error: "Enter a valid email address." });
    vals[f.label.toLowerCase()] = v;
  }
  const email = Object.entries(vals).find(([k]) => k.includes("email"))?.[1] || "";
  const name = vals["full name"] || vals["name"] || `${vals["first name"] || ""} ${vals["last name"] || ""}`.trim();
  const owner = (await db("users").where({ org_id: org.id }).orderBy("created_at").first())?.name || "";
  const { contact, created } = await upsertContact(org.id, unit, {
    name, first: vals["first name"], last: vals["last name"], email, phone: vals["phone"] || vals["phone number"],
    budget: Number(vals["budget"]) || 0, area: vals["property address"] || vals["property type"] || "",
  }, { owner, source: req.query.page ? "Landing page" : "Website", lifecycle: form.lifecycle });
  await addActivity(org.id, unit, { kind: "form", title: `Submitted form: ${form.name}`, body: Object.entries(vals).map(([k, v]) => `${k}: ${v}`).join("\n"), refs: { contact: [contact.id] } });
  const { _unit, ...f } = form;
  f.submissions = (f.submissions || 0) + 1;
  await putRecord(org.id, unit, "forms", f);
  if (req.query.page) { const p = await getRecord(org.id, "pages", String(req.query.page)); if (p) { const { _unit: u, ...pc } = p; pc.submissions = (pc.submissions || 0) + 1; await putRecord(org.id, u, "pages", pc); } }
  if (f.campaign && created) { const c = await getRecord(org.id, "campaigns", f.campaign); if (c) { const { _unit: u, ...cc } = c; cc.newContacts = (cc.newContacts || 0) + 1; await putRecord(org.id, u, "campaigns", cc); } }
  if (f.notify) await putRecord(org.id, unit, "tasks", { id: newId(), title: `Follow up on ${f.name} from ${contact.first} ${contact.last}`.trim(), due: Date.now(), kind: "Call", ref: { contact: contact.id }, done: false, owner: contact.owner || owner });
  emit(org.id, "form.submitted", { unit, form: { id: f.id, name: f.name }, contact, values: vals });
  res.json({ ok: true });
});

r.post("/public/pages/:org/:pageId/view", cors, rateLimit({ windowMs: 60000, limit: 60 }), async (req, res) => {
  const org = await orgByPublic(req.params.org);
  const p = org && (await getRecord(org.id, "pages", req.params.pageId));
  if (p) {
    const { _unit, ...pc } = p; pc.views = (pc.views || 0) + 1; await putRecord(org.id, _unit, "pages", pc);
    if (pc.campaign) { const c = await getRecord(org.id, "campaigns", pc.campaign); if (c) { const { _unit: u, ...cc } = c; cc.sessions = (cc.sessions || 0) + 1; await putRecord(org.id, u, "campaigns", cc); } }
    const form = pc.form && (await getRecord(org.id, "forms", pc.form)); if (form) { const { _unit: u, ...fc } = form; fc.views = (fc.views || 0) + 1; await putRecord(org.id, u, "forms", fc); }
  }
  res.status(204).end();
});

/* ---------- unsubscribe ---------- */
async function unsubscribe(t) {
  const p = jwt.verify(String(t || ""), config.sessionSecret);
  const org = await orgByPublic(p.o);
  if (!org) throw new Error("Unknown sender");
  await db("suppressions").insert({ org_id: org.id, email: p.e, reason: "unsubscribe" }).onConflict(["org_id", "email"]).ignore();
  return { org, email: p.e };
}
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1c2628"><h1 style="font-size:24px">${esc(title)}</h1><p>${msg}</p></body>`;
r.get("/public/unsubscribe", async (req, res) => {
  try { const { org, email } = await unsubscribe(req.query.t); res.send(page("You're unsubscribed", `${esc(email)} won't receive marketing email from ${esc(org.name)} anymore.`)); }
  catch { res.status(400).send(page("Link not valid", "This unsubscribe link is invalid or expired.")); }
});
r.post("/public/unsubscribe", express.urlencoded({ extended: false }), async (req, res) => { try { await unsubscribe(req.query.t); res.status(200).send("ok"); } catch { res.status(400).send("invalid"); } });

/* ---------- provider webhooks ---------- */
r.post("/webhooks/sendgrid", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  const ok = sendgrid.verifySignature(req.body, req.get("X-Twilio-Email-Event-Webhook-Signature"), req.get("X-Twilio-Email-Event-Webhook-Timestamp"));
  if (!ok) return res.status(403).end();
  let events; try { events = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).end(); }
  res.status(200).end();
  sendgrid.handleEvents(Array.isArray(events) ? events : []).catch((e) => console.error("sendgrid events", e.message));
});

r.post("/webhooks/zillow/:org", express.json({ limit: "256kb" }), async (req, res) => {
  const org = await orgByPublic(req.params.org);
  if (!org) return res.status(404).json({ error: "Unknown endpoint" });
  const row = await db("integrations").where({ org_id: org.id, provider: "zillow", enabled: true }).first();
  const secret = row ? decryptJson(row.config_enc).secret : null;
  const given = req.query.secret || req.get("X-Atrium-Secret") || "";
  if (!secret || !safeEqual(given, secret)) return res.status(401).json({ error: "Bad secret" });
  try {
    const owner = (await db("users").where({ org_id: org.id }).orderBy("created_at").first())?.name || "";
    const out = await zillow.ingestLead(org, req.body, row.meta?.owner || owner);
    await db("integrations").where({ org_id: org.id, provider: "zillow" }).update({ meta: db.raw("meta || ?::jsonb", [JSON.stringify({ lastLeadAt: Date.now() })]) });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.post("/webhooks/docusign/:org", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  if (!docusign.verifyConnect(req.body, req.headers)) return res.status(401).end();
  let payload; try { payload = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).end(); }
  res.status(200).end();
  docusign.handleConnect(req.params.org, payload).catch((e) => console.error("docusign connect", e.message));
});

module.exports = r;
