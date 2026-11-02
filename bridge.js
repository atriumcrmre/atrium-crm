/**
 * MLS listings through Bridge Interactive (a Zillow Group company), RESO Web API (OData).
 * Requires a Bridge server token and dataset approved by your MLS.
 */
const db = require("../db");
const { config } = require("../config");
const { decryptJson } = require("../lib/crypto");
const { putRecord, findByExt } = require("../lib/records");
const { sha1 } = require("../lib/crypto");

const SELECT = "ListingKey,ListingId,UnparsedAddress,City,SubdivisionName,PropertyType,PropertySubType,BedroomsTotal,BathroomsTotalInteger,LivingArea,ListPrice,StandardStatus,DaysOnMarket,ModificationTimestamp";
const STATUS = { Active: "Active", "Active Under Contract": "Pending", Pending: "Pending", Closed: "Sold", "Coming Soon": "Coming soon", Withdrawn: "Withdrawn", Expired: "Expired", Canceled: "Withdrawn" };

async function bridgeConfig(orgId) {
  const row = await db("integrations").where({ org_id: orgId, provider: "bridge", enabled: true }).first();
  const cfg = row ? decryptJson(row.config_enc) : {};
  return { token: cfg.serverToken || config.bridge.serverToken, dataset: cfg.dataset || config.bridge.dataset, agentMlsId: cfg.agentMlsId, officeMlsId: cfg.officeMlsId, enabled: !!row };
}

async function syncBridge(orgId) {
  const c = await bridgeConfig(orgId);
  if (!c.enabled || !c.token || !c.dataset) throw Object.assign(new Error("Add your Bridge server token and dataset under Integrations → MLS (Bridge)."), { status: 400 });
  const filters = [];
  if (c.agentMlsId) filters.push(`ListAgentMlsId eq '${String(c.agentMlsId).replace(/'/g, "")}'`);
  if (c.officeMlsId) filters.push(`ListOfficeMlsId eq '${String(c.officeMlsId).replace(/'/g, "")}'`);
  let url = `https://api.bridgedataoutput.com/api/v2/OData/${encodeURIComponent(c.dataset)}/Property?access_token=${encodeURIComponent(c.token)}&$top=200&$select=${SELECT}${filters.length ? "&$filter=" + encodeURIComponent(filters.join(" or ")) : ""}`;
  let n = 0, pages = 0;
  while (url && pages < 10) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Bridge ${r.status}: ${j.error?.message || j.message || "request failed"}`), { status: 502 });
    for (const p of j.value || []) {
      const key = `bridge:${p.ListingKey}`;
      const prev = await findByExt(orgId, "properties", key);
      const rec = {
        ...(prev?.data || {}),
        id: prev?.data.id || "l" + sha1(key).slice(0, 14),
        name: p.UnparsedAddress || p.ListingId, area: p.SubdivisionName || p.City || "", kind: p.PropertySubType || p.PropertyType || "Residential",
        beds: p.BedroomsTotal ?? 0, baths: p.BathroomsTotalInteger ?? 0, sqft: p.LivingArea ?? 0, price: p.ListPrice ?? 0,
        status: STATUS[p.StandardStatus] || p.StandardStatus || "Active", dom: p.DaysOnMarket ?? 0, mlsId: p.ListingId,
        ext: { key, provider: "bridge", modified: p.ModificationTimestamp },
      };
      await putRecord(orgId, "res", "properties", rec, { extKey: key });
      n++;
    }
    url = j["@odata.nextLink"] || null; pages++;
  }
  await db("integrations").where({ org_id: orgId, provider: "bridge" }).update({ meta: db.raw("meta || ?::jsonb", [JSON.stringify({ lastSync: Date.now(), lastCount: n })]), updated_at: db.fn.now() });
  return { listings: n };
}

async function syncBridgeAll() {
  const rows = await db("integrations").where({ provider: "bridge", enabled: true });
  for (const r of rows) await syncBridge(r.org_id).catch((e) => console.error("bridge", r.org_id, e.message));
}

module.exports = { syncBridge, syncBridgeAll };
