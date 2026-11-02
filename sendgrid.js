/**
 * Marketing email through SendGrid (v3 Mail Send + Event Webhook).
 * One render per campaign with per-recipient substitutions, sent in batches of 1,000.
 */
const crypto = require("crypto");
const db = require("../db");
const { config } = require("../config");
const { renderEmail, renderText } = require("../lib/render");
const { putRecord, getRecord, listRecords, addActivity } = require("../lib/records");
const { emit } = require("../lib/webhooks");
const jwt = require("jsonwebtoken");

const isConfigured = () => !!(config.sendgrid.apiKey && config.sendgrid.fromEmail);

/** Lists the app offers, resolved against live contact data. */
const LISTS = {
  res: {
    "Active buyers": (c) => c.type === "Buyer" && c.lifecycle !== "Customer",
    "Open house attendees": (c, ctx) => c.source === "Open house" || ctx.formContacts.has(c.id),
    "Homeowners 5+ yrs": (c) => c.type === "Seller",
    "Renters & first-time buyers": (c) => c.type === "Renter" || /first-time/i.test(JSON.stringify(c.tags || "")),
    "Past clients": (c) => c.lifecycle === "Customer",
    "All residential contacts": () => true,
  },
  com: {
    "Industrial tenants & brokers": (c) => c.type === "Tenant" && /industrial/i.test(c.area || ""),
    "Office tenants 10K+ SF": (c) => c.type === "Tenant" && /office/i.test(c.area || ""),
    "Private investors": (c) => c.type === "Investor",
    "Retail tenants": (c) => c.type === "Tenant" && /retail/i.test(c.area || ""),
    "All commercial contacts": () => true,
  },
};

async function recipients(orgId, unit, listName) {
  const contacts = await listRecords(orgId, { unit, type: "contacts" });
  const acts = await listRecords(orgId, { unit, type: "acts" });
  const formContacts = new Set(acts.filter((a) => a.kind === "form").flatMap((a) => a.refs?.contact || []));
  const test = LISTS[unit]?.[listName] || (() => true);
  const suppressed = new Set((await db("suppressions").where({ org_id: orgId }).select("email")).map((r) => r.email));
  const seen = new Set();
  return contacts.filter((c) => {
    const e = String(c.email || "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || suppressed.has(e) || seen.has(e)) return false;
    seen.add(e);
    return test(c, { formContacts });
  });
}

const unsubToken = (orgPublicId, email) => jwt.sign({ o: orgPublicId, e: email }, config.sessionSecret, { expiresIn: "400d" });
const unsubUrl = (orgPublicId, email) => `${config.publicApiUrl}/public/unsubscribe?t=${encodeURIComponent(unsubToken(orgPublicId, email))}`;

async function sgSend(body) {
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { Authorization: `Bearer ${config.sendgrid.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status >= 300) { const t = await r.text(); throw new Error(`SendGrid ${r.status}: ${t.slice(0, 300)}`); }
}

/** Send a marketing email record to its list. Returns { recipients }. */
async function sendCampaignEmail(org, unit, emailId, { siteBase } = {}) {
  if (!isConfigured()) throw Object.assign(new Error("SendGrid isn't configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL on the server."), { status: 503 });
  const email = await getRecord(org.id, "emails", emailId);
  if (!email) throw Object.assign(new Error("Email not found"), { status: 404 });
  const list = await recipients(org.id, unit, email.list);
  if (!list.length) throw Object.assign(new Error(`No contacts with valid email addresses on “${email.list}”.`), { status: 400 });

  const accent = unit === "com" ? "#1f6fd1" : "#0e8c6a";
  const html = renderEmail(email, { first_name: "-first_name-", last_name: "-last_name-", company_name: config.sendgrid.fromName }, { unsubscribeUrl: "-unsub_url-", accent, siteBase });
  const text = renderText(email, { first_name: "-first_name-", last_name: "-last_name-" }, "-unsub_url-");
  const subject = String(email.subject || "").replace(/\{first_name\}/g, "-first_name-").replace(/\{last_name\}/g, "-last_name-");

  for (let i = 0; i < list.length; i += 1000) {
    const batch = list.slice(i, i + 1000);
    await sgSend({
      from: { email: config.sendgrid.fromEmail, name: config.sendgrid.fromName },
      subject, content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }],
      personalizations: batch.map((c) => {
        const u = unsubUrl(org.public_id, c.email.toLowerCase());
        return {
          to: [{ email: c.email, name: `${c.first} ${c.last}`.trim() }],
          substitutions: { "-first_name-": c.first || "there", "-last_name-": c.last || "", "-unsub_url-": u },
          headers: { "List-Unsubscribe": `<${u}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          custom_args: { atrium_org: org.public_id, atrium_email: email.id, atrium_contact: c.id, atrium_unit: unit },
        };
      }),
      tracking_settings: { click_tracking: { enable: true, enable_text: false }, open_tracking: { enable: true } },
      categories: ["atrium-marketing"],
    });
    await db("marketing_sends").insert(batch.map((c) => ({ org_id: org.id, unit, email_id: email.id, contact_id: c.id, to_email: c.email.toLowerCase(), status: "sent" }))).onConflict(["org_id", "email_id", "to_email"]).ignore();
  }
  const { _unit, ...clean } = email;
  Object.assign(clean, { status: "Sent", sentAt: Date.now(), recipients: list.length, openRate: 0, clickRate: 0 });
  await putRecord(org.id, unit, "emails", clean);
  return { recipients: list.length };
}

/** One-off test send of a marketing email to a single address. */
async function sendTest(org, unit, emailId, to) {
  if (!isConfigured()) throw Object.assign(new Error("SendGrid isn't configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL on the server."), { status: 503 });
  const email = await getRecord(org.id, "emails", emailId);
  if (!email) throw Object.assign(new Error("Email not found"), { status: 404 });
  const vars = { first_name: "Test", last_name: "Recipient" };
  await sgSend({
    from: { email: config.sendgrid.fromEmail, name: config.sendgrid.fromName }, subject: "[Test] " + String(email.subject).replace(/\{first_name\}/g, "Test"),
    personalizations: [{ to: [{ email: to }] }],
    content: [{ type: "text/plain", value: renderText(email, vars, "#") }, { type: "text/html", value: renderEmail(email, vars, { unsubscribeUrl: "#", accent: unit === "com" ? "#1f6fd1" : "#0e8c6a" }) }],
  });
}

/** Verify SendGrid's signed event webhook (ECDSA P-256). */
function verifySignature(rawBody, sig, ts) {
  const pub = config.sendgrid.webhookPublicKey;
  if (!pub) return true; // verification off until a key is configured
  if (!sig || !ts) return false;
  const pem = `-----BEGIN PUBLIC KEY-----\n${pub.replace(/\s+/g, "").match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
  try { return crypto.verify("sha256", Buffer.concat([Buffer.from(ts), rawBody]), { key: pem, dsaEncoding: "der" }, Buffer.from(sig, "base64")); }
  catch { return false; }
}

async function handleEvents(events) {
  const touched = new Map();
  for (const ev of events) {
    const org = ev.atrium_org && (await db("orgs").where({ public_id: ev.atrium_org }).first());
    if (!org) continue;
    const email = String(ev.email || "").toLowerCase();
    const where = { org_id: org.id, email_id: ev.atrium_email, to_email: email };
    const at = new Date((ev.timestamp || Date.now() / 1000) * 1000);
    const row = await db("marketing_sends").where(where).first();
    if (!row) continue;
    const upd = {};
    if (ev.event === "delivered") { upd.delivered_at = at; upd.status = "delivered"; }
    if (ev.event === "open" && !row.opened_at) {
      upd.opened_at = at;
      emit(org.id, "email.opened", { unit: row.unit, email_id: row.email_id, contact_id: row.contact_id });
      const em = await getRecord(org.id, "emails", row.email_id);
      if (row.contact_id) await addActivity(org.id, row.unit, { kind: "email", title: `Opened: ${em?.subject || "marketing email"}`, refs: { contact: [row.contact_id] }, extra: { dir: "out", marketing: true } });
    }
    if (ev.event === "click" && !row.clicked_at) { upd.clicked_at = at; if (!row.opened_at) upd.opened_at = at; emit(org.id, "email.clicked", { unit: row.unit, email_id: row.email_id, contact_id: row.contact_id, url: ev.url }); }
    if (["bounce", "dropped"].includes(ev.event)) { upd.bounced_at = at; upd.status = ev.event; await db("suppressions").insert({ org_id: org.id, email, reason: ev.event }).onConflict(["org_id", "email"]).ignore(); }
    if (["unsubscribe", "group_unsubscribe", "spamreport"].includes(ev.event)) await db("suppressions").insert({ org_id: org.id, email, reason: ev.event }).onConflict(["org_id", "email"]).ignore();
    if (Object.keys(upd).length) await db("marketing_sends").where(where).update({ ...upd, updated_at: db.fn.now() });
    touched.set(`${org.id}|${row.unit}|${row.email_id}`, true);
  }
  for (const k of touched.keys()) await recomputeStats(...k.split("|"));
}

async function recomputeStats(orgId, unit, emailId) {
  const [s] = await db("marketing_sends").where({ org_id: orgId, email_id: emailId })
    .select(db.raw("count(*)::int as sent"), db.raw("count(opened_at)::int as opened"), db.raw("count(clicked_at)::int as clicked"), db.raw("count(bounced_at)::int as bounced"));
  const email = await getRecord(orgId, "emails", emailId);
  if (!email) return;
  const delivered = Math.max(1, s.sent - s.bounced);
  const { _unit, ...clean } = email;
  Object.assign(clean, { openRate: +((s.opened / delivered) * 100).toFixed(1), clickRate: +((s.clicked / delivered) * 100).toFixed(1), stats: s });
  await putRecord(orgId, unit, "emails", clean);
}

module.exports = { isConfigured, LISTS, recipients, sendCampaignEmail, sendTest, verifySignature, handleEvents, unsubToken };
