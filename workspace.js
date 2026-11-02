const express = require("express");
const db = require("../db");
const { requireUser } = require("../lib/auth");
const { TYPES, UNITS, applySync, putRecord, getRecord, addActivity, newId } = require("../lib/records");
const { syncAccount } = require("../services/worker");
const { sendMail } = require("../services/mail");
const calendar = require("../services/calendar");

const r = express.Router();
r.use(requireUser);

const empty = () => Object.fromEntries(TYPES.map((t) => [t, []]));

/** Full workspace for both business units. */
r.get("/workspace", async (req, res) => {
  const cursor = Date.now() - 3000;
  const rows = await db("records").where({ org_id: req.orgId, deleted: false }).select("unit", "type", "data");
  const data = { res: empty(), com: empty() };
  for (const row of rows) if (data[row.unit]?.[row.type]) data[row.unit][row.type].push(row.data);
  res.json({ data, cursor });
});

/** Batched client changes: { changes: { res: { contacts: { upsert: [...], delete: [...] } } } } */
r.post("/sync", express.json({ limit: "8mb" }), async (req, res) => {
  const clientId = String(req.get("X-Client-Id") || "web").slice(0, 64);
  const result = await applySync(req.orgId, clientId, req.body?.changes || {}, {
    onDelete: (unit, type, data) => { if (type === "events" && data?.ext) calendar.deleteProviderEvent(req.orgId, data.ext); },
  });
  res.json({ ok: true, ...result });
});

/** Records changed by anyone else (server sync, teammates) since a cursor. */
r.get("/changes", async (req, res) => {
  const since = Number(req.query.since) || 0;
  const clientId = String(req.get("X-Client-Id") || "");
  const cursor = Date.now() - 3000;
  const rows = await db("records").where({ org_id: req.orgId }).andWhere("updated_ms", ">", since)
    .andWhere((q) => q.whereNull("updated_by").orWhereNot("updated_by", clientId)).orderBy("updated_ms").limit(2000)
    .select("unit", "type", "id", "deleted", "data");
  const accts = await db("oauth_accounts").where({ org_id: req.orgId, user_id: req.user.id }).select("last_mail_sync_at", "last_cal_sync_at");
  const lastSync = Math.max(0, ...accts.map((a) => Math.max(+new Date(a.last_mail_sync_at || 0), +new Date(a.last_cal_sync_at || 0))));
  res.json({ records: rows, cursor: rows.length === 2000 ? Number(rows[rows.length - 1].updated_ms) : cursor, lastSync });
});

/* ---------- connected mail & calendar accounts ---------- */
const publicAcct = (a) => ({ id: a.id, provider: a.provider, email: a.email, mail: a.mail_enabled, calendar: a.cal_enabled, lastMailSync: a.last_mail_sync_at, lastCalSync: a.last_cal_sync_at, error: a.last_error });

r.get("/connections", async (req, res) => {
  const rows = await db("oauth_accounts").where({ user_id: req.user.id }).orderBy("created_at");
  res.json({ accounts: rows.map(publicAcct) });
});

r.patch("/connections/:id", async (req, res) => {
  const upd = {};
  if (typeof req.body.mail === "boolean") upd.mail_enabled = req.body.mail;
  if (typeof req.body.calendar === "boolean") upd.cal_enabled = req.body.calendar;
  await db("oauth_accounts").where({ id: req.params.id, user_id: req.user.id }).update(upd);
  res.json({ ok: true });
});

r.delete("/connections/:id", async (req, res) => {
  await db("oauth_accounts").where({ id: req.params.id, user_id: req.user.id }).del();
  res.json({ ok: true });
});

r.post("/connections/sync", async (req, res) => {
  const accts = await db("oauth_accounts").where({ user_id: req.user.id });
  const results = [];
  for (const a of accts) results.push({ email: a.email, ...(await syncAccount(a)) });
  res.json({ results });
});

async function mailAccount(userId) {
  const accts = await db("oauth_accounts").where({ user_id: userId, mail_enabled: true }).orderBy("created_at");
  return accts[0] || null;
}

/** Send one-to-one email from the user's connected Gmail/Outlook and log it. */
r.post("/mail/send", async (req, res) => {
  const { to, subject, body = "", unit = req.user.default_unit, contactId, refs = {}, replyTo } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: "Add a recipient and a subject." });
  if (!UNITS.includes(unit)) return res.status(400).json({ error: "Unknown business unit." });
  const acct = await mailAccount(req.user.id);
  if (!acct) return res.status(400).json({ error: "Connect Gmail or Outlook first (Inbox → Connect)." });
  let threadId = null, inReplyTo = null;
  if (replyTo) { const orig = await getRecord(req.orgId, "mail", replyTo); threadId = orig?.ext?.provider === acct.provider ? orig.ext.threadId : null; }
  try {
    const sent = await sendMail(acct, { to, subject, body, fromName: req.user.name, threadId, inReplyTo });
    const contact = contactId ? await getRecord(req.orgId, "contacts", contactId) : (await db("records").where({ org_id: req.orgId, type: "contacts", email: String(to).split(",")[0].trim().toLowerCase(), deleted: false }).first())?.data;
    const extKey = sent.extId ? `${acct.provider}:${sent.extId}` : null;
    const mail = { id: newId(), from: { name: req.user.name, email: acct.email }, to, subject, body, ts: Date.now(), read: true, folder: "sent", contact: contact?.id || null, ...(extKey ? { ext: { key: extKey, provider: acct.provider, threadId: sent.threadId, account: acct.email } } : {}) };
    await putRecord(req.orgId, unit, "mail", mail, { extKey });
    const act = await addActivity(req.orgId, unit, { kind: "email", title: subject, body, refs: { ...refs, contact: [...new Set([...(refs.contact || []), ...(contact ? [contact.id] : [])])] }, extra: { dir: "out", mailId: mail.id } });
    res.json({ ok: true, mail, act });
  } catch (e) {
    res.status(502).json({ error: `Couldn't send: ${e.message}` });
  }
});

/** Create a meeting on the user's connected calendar (Google or Outlook) and log it. */
r.post("/calendar/events", async (req, res) => {
  const { title, start, dur = 45, loc = "", contactId, unit = req.user.default_unit, kind = "Meeting", refs = {} } = req.body || {};
  if (!title || !start) return res.status(400).json({ error: "A meeting needs a title and a start time." });
  const contact = contactId ? await getRecord(req.orgId, "contacts", contactId) : null;
  const acct = await db("oauth_accounts").where({ user_id: req.user.id, cal_enabled: true }).orderBy("created_at").first();
  try {
    let ev;
    if (acct) ev = await calendar.createEvent(acct, req.user, unit, { title, start: Number(start), dur: Number(dur), loc, kind }, contact);
    else { ev = { id: newId(), title, start: Number(start), dur: Number(dur), loc, contact: contact?.id || null, kind, source: "Atrium" }; await putRecord(req.orgId, unit, "events", ev); }
    const act = await addActivity(req.orgId, unit, { kind: "meeting", title, body: `${new Date(ev.start).toISOString()} · ${ev.loc}${acct && contact?.email ? " · invite sent" : ""}`, refs: { ...refs, contact: contact ? [contact.id] : refs.contact || [] }, extra: { eventId: ev.id } });
    res.json({ ok: true, event: ev, act, synced: !!acct });
  } catch (e) {
    res.status(502).json({ error: `Couldn't create the meeting: ${e.message}` });
  }
});

module.exports = r;
