const express = require("express");
const db = require("../db");
const { requireUser } = require("../lib/auth");
const sendgrid = require("../services/sendgrid");
const netlify = require("../services/netlify");
const { getRecord, putRecord } = require("../lib/records");

const r = express.Router();
r.use(requireUser);

const org = (req) => db("orgs").where({ id: req.orgId }).first();

r.get("/marketing/lists", async (req, res) => {
  const unit = req.query.unit === "com" ? "com" : "res";
  const out = {};
  for (const name of Object.keys(sendgrid.LISTS[unit])) out[name] = (await sendgrid.recipients(req.orgId, unit, name)).length;
  res.json({ lists: out, sendgrid: sendgrid.isConfigured() });
});

r.post("/marketing/emails/:id/send", async (req, res) => {
  try {
    const o = await org(req);
    const nf = await netlify.credentials(req.orgId).catch(() => ({}));
    const out = await sendgrid.sendCampaignEmail(o, req.body.unit === "com" ? "com" : "res", req.params.id, { siteBase: nf.meta?.url });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.post("/marketing/emails/:id/test", async (req, res) => {
  try {
    await sendgrid.sendTest(await org(req), req.body.unit === "com" ? "com" : "res", req.params.id, req.body.to || req.user.email);
    res.json({ ok: true, to: req.body.to || req.user.email });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/** Publish or unpublish a landing page, then redeploy the org's Netlify site. */
r.post("/pages/:id/publish", async (req, res) => {
  const unit = req.body.unit === "com" ? "com" : "res";
  const page = await getRecord(req.orgId, "pages", req.params.id);
  if (!page) return res.status(404).json({ error: "Page not found" });
  const { _unit, ...clean } = page;
  const before = clean.status;
  clean.status = req.body.publish === false ? "Draft" : "Published";
  if (!clean.slug) clean.slug = String(clean.name || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await putRecord(req.orgId, unit, "pages", clean);
  try {
    const out = await netlify.deployPages(await org(req));
    const updated = await getRecord(req.orgId, "pages", req.params.id);
    res.json({ ok: true, url: updated.url, site: out.url, page: updated });
  } catch (e) {
    clean.status = before;
    await putRecord(req.orgId, unit, "pages", clean);
    res.status(e.status || 502).json({ error: e.message });
  }
});

module.exports = r;
