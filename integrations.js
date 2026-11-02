const express = require("express");
const multer = require("multer");
const db = require("../db");
const { config } = require("../config");
const { requireUser, requireRole } = require("../lib/auth");
const { encryptJson, decryptJson, randomToken, sha256 } = require("../lib/crypto");
const { getRecord } = require("../lib/records");
const { EVENTS, deliver } = require("../lib/webhooks");
const bridge = require("../services/bridge");
const costar = require("../services/costar");
const docusign = require("../services/docusign");
const netlify = require("../services/netlify");
const sendgrid = require("../services/sendgrid");
const oauth = require("../services/oauth");

const r = express.Router();
r.use(requireUser);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/** Keys each provider accepts. Secrets are stored encrypted and never sent back. */
const FIELDS = {
  zillow: { secret: [], public: ["owner"] },
  bridge: { secret: ["serverToken"], public: ["dataset", "agentMlsId", "officeMlsId"] },
  docusign: { secret: ["privateKey"], public: ["integrationKey", "userId", "accountId", "authServer", "defaultTemplateId"] },
  netlify: { secret: ["token"], public: [] },
  costar: { secret: [], public: [] },
};

r.get("/integrations", async (req, res) => {
  const org = await db("orgs").where({ id: req.orgId }).first();
  const rows = await db("integrations").where({ org_id: req.orgId });
  const byP = Object.fromEntries(rows.map((x) => [x.provider, x]));
  const cfg = (p) => (byP[p] ? decryptJson(byP[p].config_enc) : {});
  const ds = await docusign.dsConfig(req.orgId);
  const nf = await netlify.credentials(req.orgId);
  const zs = cfg("zillow");
  res.json({
    zillow: { connected: !!byP.zillow?.enabled, webhookUrl: byP.zillow ? `${config.publicApiUrl}/webhooks/zillow/${org.public_id}?secret=${zs.secret}` : null, ...byP.zillow?.meta },
    bridge: { connected: !!byP.bridge?.enabled, ...pub("bridge", cfg("bridge")), hasToken: !!(cfg("bridge").serverToken || config.bridge.serverToken), ...byP.bridge?.meta },
    costar: { connected: true, ...byP.costar?.meta },
    docusign: { connected: docusign.isConfigured(ds), ...pub("docusign", ds), hasKey: !!ds.privateKey, connectUrl: `${config.publicApiUrl}/webhooks/docusign/${org.public_id}` },
    netlify: { connected: !!nf.token, siteUrl: nf.meta?.url || null, fromServer: !!config.netlify.token && !cfg("netlify").token },
    sendgrid: { connected: sendgrid.isConfigured(), fromEmail: config.sendgrid.fromEmail || null, eventWebhookUrl: `${config.publicApiUrl}/webhooks/sendgrid` },
    google: { available: oauth.isConfigured("google") }, microsoft: { available: oauth.isConfigured("microsoft") },
  });
});
const pub = (p, c) => Object.fromEntries(FIELDS[p].public.map((k) => [k, c[k] || null]));

r.put("/integrations/:provider", requireRole("owner", "admin"), async (req, res) => {
  const p = req.params.provider;
  if (!FIELDS[p]) return res.status(404).json({ error: "Unknown integration" });
  const row = await db("integrations").where({ org_id: req.orgId, provider: p }).first();
  const current = row ? decryptJson(row.config_enc) : {};
  const incoming = req.body?.config || {};
  for (const k of [...FIELDS[p].secret, ...FIELDS[p].public]) if (incoming[k] !== undefined && incoming[k] !== "") current[k] = String(incoming[k]);
  if (p === "zillow" && !current.secret) current.secret = randomToken(18);
  const meta = { ...(row?.meta || {}), ...(p === "zillow" && incoming.owner ? { owner: String(incoming.owner) } : {}) };
  await db("integrations").insert({ org_id: req.orgId, provider: p, enabled: req.body.enabled !== false, config_enc: encryptJson(current), meta })
    .onConflict(["org_id", "provider"]).merge({ enabled: req.body.enabled !== false, config_enc: encryptJson(current), meta, updated_at: db.fn.now() });
  res.json({ ok: true });
});

r.delete("/integrations/:provider", requireRole("owner", "admin"), async (req, res) => {
  await db("integrations").where({ org_id: req.orgId, provider: req.params.provider }).del();
  res.json({ ok: true });
});

r.post("/integrations/bridge/sync", async (req, res) => {
  try { res.json({ ok: true, ...(await bridge.syncBridge(req.orgId)) }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.post("/integrations/costar/import", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Attach a CSV export from CoStar." });
  if (/\.xlsx?$/i.test(req.file.originalname)) return res.status(400).json({ error: "Save the CoStar export as CSV first (File → Save As → CSV), then upload it." });
  try {
    const org = await db("orgs").where({ id: req.orgId }).first();
    const out = await costar.importCostar(org, req.file.buffer.toString("utf8"), req.user.name);
    await db("integrations").insert({ org_id: req.orgId, provider: "costar", enabled: true, config_enc: encryptJson({}), meta: { lastImport: Date.now(), lastResult: out } })
      .onConflict(["org_id", "provider"]).merge({ meta: { lastImport: Date.now(), lastResult: out }, updated_at: db.fn.now() });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.post("/docusign/envelopes", upload.single("file"), async (req, res) => {
  const { dealId, unit = "res", subject, message, templateId, roleName, signerName, signerEmail, contactId } = req.body || {};
  if (!signerEmail) return res.status(400).json({ error: "Choose a signer with an email address." });
  if (req.file && !/pdf$/i.test(req.file.mimetype) && !/\.pdf$/i.test(req.file.originalname)) return res.status(400).json({ error: "Upload a PDF." });
  try {
    const org = await db("orgs").where({ id: req.orgId }).first();
    const deal = dealId ? await getRecord(req.orgId, "deals", dealId) : null;
    const out = await docusign.sendEnvelope(org, {
      dealId: deal?.id, contactId, unit: unit === "com" ? "com" : "res", subject: subject || (deal ? `Please sign: ${deal.name}` : "Please sign"), message,
      templateId, roleName, signer: { name: signerName, email: signerEmail },
      ...(req.file ? { pdfBase64: req.file.buffer.toString("base64"), fileName: req.file.originalname } : {}),
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.get("/docusign/envelopes", async (req, res) => {
  const q = db("envelopes").where({ org_id: req.orgId }).orderBy("created_at", "desc").limit(100);
  if (req.query.dealId) q.andWhere({ deal_id: String(req.query.dealId) });
  res.json({ envelopes: await q });
});

/* ---------- API keys ---------- */
r.get("/api-keys", async (req, res) => {
  res.json({ keys: await db("api_keys").where({ org_id: req.orgId }).whereNull("revoked_at").select("id", "name", "prefix", "created_at", "last_used_at").orderBy("created_at", "desc") });
});
r.post("/api-keys", requireRole("owner", "admin"), async (req, res) => {
  const key = "atr_live_" + randomToken(24).replace(/[^A-Za-z0-9]/g, "");
  const [row] = await db("api_keys").insert({ org_id: req.orgId, name: String(req.body.name || "API key").slice(0, 80), prefix: key.slice(0, 14), key_hash: sha256(key) }).returning(["id", "name", "prefix", "created_at"]);
  res.json({ ...row, key }); // the full key is shown once
});
r.delete("/api-keys/:id", requireRole("owner", "admin"), async (req, res) => {
  await db("api_keys").where({ id: req.params.id, org_id: req.orgId }).update({ revoked_at: db.fn.now() });
  res.json({ ok: true });
});

/* ---------- outbound webhooks ---------- */
r.get("/webhooks", async (req, res) => {
  res.json({ events: EVENTS, webhooks: await db("webhooks").where({ org_id: req.orgId }).select("id", "url", "event", "secret", "last_delivery_at", "last_status").orderBy("created_at") });
});
r.post("/webhooks", requireRole("owner", "admin"), async (req, res) => {
  const url = String(req.body.url || "");
  if (!/^https:\/\/[^\s]+$/.test(url) && !(config.env !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)/.test(url))) return res.status(400).json({ error: "Use an https:// URL." });
  if (!EVENTS.includes(req.body.event)) return res.status(400).json({ error: "Unknown event." });
  const [row] = await db("webhooks").insert({ org_id: req.orgId, url, event: req.body.event, secret: randomToken(24) }).returning("*");
  res.json(row);
});
r.delete("/webhooks/:id", requireRole("owner", "admin"), async (req, res) => {
  await db("webhooks").where({ id: req.params.id, org_id: req.orgId }).del();
  res.json({ ok: true });
});
r.post("/webhooks/:id/test", async (req, res) => {
  const h = await db("webhooks").where({ id: req.params.id, org_id: req.orgId }).first();
  if (!h) return res.status(404).json({ error: "Not found" });
  const status = await deliver(h, h.event, { test: true, message: "Test delivery from Atrium" }, 3);
  res.json({ status });
});

module.exports = r;
