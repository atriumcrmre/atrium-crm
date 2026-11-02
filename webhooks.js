const { hmacHex } = require("./crypto");

const EVENTS = ["contact.created", "contact.updated", "company.created", "deal.created", "deal.stage_changed", "deal.won", "ticket.created", "ticket.status_changed", "form.submitted", "email.opened", "email.clicked", "meeting.booked", "envelope.completed"];

/**
 * Outbound webhooks. Each delivery is signed:
 *   X-Atrium-Signature: sha256=<hex HMAC of "<timestamp>.<body>" using the webhook's secret>
 *   X-Atrium-Timestamp: <unix seconds>
 * Retries 3 times with backoff on network errors and 5xx responses.
 */
function emit(orgId, event, payload) {
  // Lazy require avoids a circular import with db -> records -> webhooks.
  const db = require("../db");
  setImmediate(async () => {
    try {
      const hooks = await db("webhooks").where({ org_id: orgId, event });
      for (const h of hooks) deliver(h, event, payload).catch(() => {});
    } catch (e) {
      console.error("webhook lookup failed", e.message);
    }
  });
}

async function deliver(hook, event, payload, attempt = 1) {
  const db = require("../db");
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: `${ts}-${Math.random().toString(36).slice(2, 8)}`, event, occurred_at: new Date().toISOString(), data: payload });
  let status = 0;
  try {
    const r = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Atrium-Webhooks/1.0", "X-Atrium-Event": event, "X-Atrium-Timestamp": String(ts), "X-Atrium-Signature": "sha256=" + hmacHex(hook.secret, `${ts}.${body}`) },
      body,
      signal: AbortSignal.timeout(10000),
    });
    status = r.status;
  } catch {
    status = 0;
  }
  await db("webhooks").where({ id: hook.id }).update({ last_delivery_at: db.fn.now(), last_status: status }).catch(() => {});
  if ((status === 0 || status >= 500) && attempt < 3) setTimeout(() => deliver(hook, event, payload, attempt + 1), attempt * 30000);
  return status;
}

module.exports = { EVENTS, emit, deliver };
