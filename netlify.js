/**
 * Landing-page hosting on Netlify. Each organization gets one Netlify site; every
 * publish re-deploys all published pages with the file-digest deploy API, so
 * unpublished pages disappear from the live site.
 */
const db = require("../db");
const { config } = require("../config");
const { sha1, decryptJson, encryptJson } = require("../lib/crypto");
const { listRecords, putRecord } = require("../lib/records");
const { renderLandingPage, renderIndex } = require("../lib/render");

const API = "https://api.netlify.com/api/v1";

async function credentials(orgId) {
  const row = await db("integrations").where({ org_id: orgId, provider: "netlify" }).first();
  const cfg = row ? decryptJson(row.config_enc) : {};
  return { row, token: cfg.token || config.netlify.token, siteId: row?.meta?.siteId || config.netlify.siteId || null, meta: row?.meta || {}, cfg };
}

async function nf(token, path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok) throw Object.assign(new Error(`Netlify ${r.status}: ${j.message || t.slice(0, 200)}`), { status: 502 });
  return j;
}

async function ensureSite(orgId, org) {
  const c = await credentials(orgId);
  if (!c.token) throw Object.assign(new Error("Netlify isn't connected. Add a Netlify personal access token under Integrations, or set NETLIFY_AUTH_TOKEN."), { status: 503 });
  if (c.siteId) {
    const site = await nf(c.token, `/sites/${c.siteId}`);
    return { token: c.token, site };
  }
  const base = String(org.name || "atrium").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "atrium";
  const site = await nf(c.token, "/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${base}-${org.public_id.slice(0, 6).toLowerCase()}` }) });
  await db("integrations").insert({ org_id: orgId, provider: "netlify", enabled: true, config_enc: encryptJson(c.cfg), meta: { siteId: site.id, url: site.ssl_url || site.url, name: site.name } })
    .onConflict(["org_id", "provider"]).merge({ meta: { ...c.meta, siteId: site.id, url: site.ssl_url || site.url, name: site.name }, updated_at: db.fn.now() });
  return { token: c.token, site };
}

/** Deploy every published page across both business units. Returns { url, pages }. */
async function deployPages(org) {
  const { token, site } = await ensureSite(org.id, org);
  const all = await listRecords(org.id, { type: "pages" });
  const forms = await listRecords(org.id, { type: "forms" });
  const published = all.filter((p) => p.status === "Published" && p.slug);
  const files = {};
  for (const p of published) {
    const form = forms.find((f) => f.id === p.form);
    files[`/${p.slug}/index.html`] = renderLandingPage(p, form, { orgPublicId: org.public_id, unit: p._unit, brand: org.name });
  }
  files["/index.html"] = renderIndex(published, org.name);
  files["/robots.txt"] = "User-agent: *\nAllow: /\n";

  const digests = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha1(Buffer.from(c, "utf8"))]));
  const deploy = await nf(token, `/sites/${site.id}/deploys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: digests }) });
  const required = new Set(deploy.required || []);
  for (const [path, content] of Object.entries(files)) {
    if (!required.has(digests[path])) continue;
    await nf(token, `/deploys/${deploy.id}/files${path}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(content, "utf8") });
  }
  const base = (site.ssl_url || site.url || "").replace(/\/$/, "");
  for (const p of all) {
    const url = p.status === "Published" ? `${base}/${p.slug}/` : null;
    if (p.url !== url) { const { _unit, _type, ...clean } = p; clean.url = url; await putRecord(org.id, _unit, "pages", clean); }
  }
  return { url: base, pages: published.length, deployId: deploy.id };
}

module.exports = { deployPages, credentials };
