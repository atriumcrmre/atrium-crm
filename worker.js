const cron = require("node-cron");
const db = require("../db");
const { syncMail } = require("./mail");
const { syncCalendar } = require("./calendar");

const running = new Set();

/** Sync one account now (mail and/or calendar). Safe to call concurrently; overlapping runs are skipped. */
async function syncAccount(acct, { mail = true, cal = true } = {}) {
  if (running.has(acct.id)) return { skipped: true };
  running.add(acct.id);
  const out = {};
  try {
    if (mail && acct.mail_enabled) out.mail = await syncMail(acct).catch((e) => ({ error: e.message }));
    if (cal && acct.cal_enabled) out.cal = await syncCalendar(acct).then(() => "ok").catch((e) => ({ error: e.message }));
  } finally {
    running.delete(acct.id);
  }
  return out;
}

function start() {
  // Mail and calendar every minute.
  cron.schedule("* * * * *", async () => {
    const accts = await db("oauth_accounts").where((q) => q.where({ mail_enabled: true }).orWhere({ cal_enabled: true }));
    for (const a of accts) await syncAccount(a);
  });
  // Scheduled marketing emails.
  cron.schedule("* * * * *", async () => {
    const sendgrid = require("./sendgrid");
    const { putRecord } = require("../lib/records");
    const due = await db("records").where({ type: "emails", deleted: false }).whereRaw("data->>'status' = 'Scheduled' and (data->>'sentAt')::bigint <= ?", [Date.now()]);
    for (const r of due) {
      const org = await db("orgs").where({ id: r.org_id }).first();
      try { await sendgrid.sendCampaignEmail(org, r.unit, r.data.id); }
      catch (e) { await putRecord(r.org_id, r.unit, "emails", { ...r.data, status: "Draft", sendError: `Scheduled send failed: ${e.message}` }); }
    }
  });
  // MLS listings (Zillow Bridge) hourly.
  cron.schedule("17 * * * *", async () => {
    const { syncBridgeAll } = require("./bridge");
    await syncBridgeAll().catch((e) => console.error("bridge sync", e.message));
  });
  console.log("Background sync: mail and calendars every minute, MLS listings hourly.");
}

module.exports = { start, syncAccount };
