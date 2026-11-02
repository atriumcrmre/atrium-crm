/**
 * Gmail (Gmail API) and Outlook (Microsoft Graph) mail sync and sending.
 * Sync is incremental: Gmail uses historyId, Graph uses delta links. The worker
 * runs it every minute; the "Sync now" button and OAuth connect run it immediately.
 */
const db = require("../db");
const { api } = require("./oauth");
const { sha1 } = require("../lib/crypto");
const { putRecord, findByExt, findContactByEmail, addActivity } = require("../lib/records");

const DAYS_BACK = 30;
const MAX_BODY = 20000;

const parseAddress = (s = "") => {
  const m = String(s).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || m[2], email: m[2].trim().toLowerCase() } : { name: s.trim(), email: s.trim().toLowerCase() };
};
const firstAddress = (s = "") => parseAddress(String(s).split(",")[0] || "");
const stripHtml = (h = "") => h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();

/** Store one message as a `mail` record, match it to a contact and log it to the timeline. */
async function ingest(acct, user, settings, m) {
  const extKey = `${acct.provider}:${m.extId}`;
  if (await findByExt(acct.org_id, "mail", extKey)) return false;

  // A message we sent through Atrium is already stored without a provider id; attach the id instead of duplicating it.
  if (m.folder === "sent") {
    const local = await db("records").where({ org_id: acct.org_id, type: "mail" }).whereNull("ext_key")
      .whereRaw("data->>'folder' = 'sent' and lower(data->>'to') = ? and data->>'subject' = ?", [m.to.toLowerCase(), m.subject])
      .whereRaw("abs((data->>'ts')::bigint - ?) < 900000", [m.ts]).first();
    if (local) { await db("records").where({ org_id: acct.org_id, type: "mail", id: local.id }).update({ ext_key: extKey }); return false; }
  }

  const counterpart = m.folder === "sent" ? firstAddress(m.to).email : m.from.email;
  const hit = await findContactByEmail(acct.org_id, counterpart);
  const unit = hit?.unit || user.default_unit || "res";
  const rec = {
    id: "m" + sha1(extKey).slice(0, 16),
    from: m.from, to: m.to, subject: m.subject || "(no subject)", body: (m.body || "").slice(0, MAX_BODY),
    ts: m.ts, read: m.read, folder: m.folder, contact: hit?.data.id || null,
    ext: { key: extKey, provider: acct.provider, threadId: m.threadId || null, account: acct.email },
  };
  await putRecord(acct.org_id, unit, "mail", rec, { extKey });
  if (hit && settings.logAuto !== false) {
    await addActivity(acct.org_id, unit, { kind: "email", title: rec.subject, body: rec.body.slice(0, 1500), refs: { contact: [hit.data.id] }, extra: { dir: m.folder === "sent" ? "out" : "in", ts: m.ts, mailId: rec.id } });
  }
  return true;
}

/* ---------------- Gmail ---------------- */
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

function gmailBody(payload) {
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
    if (p.mimeType === "text/plain" && data && !plain) plain = data;
    if (p.mimeType === "text/html" && data && !html) html = data;
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return plain || stripHtml(html);
}

async function gmailFetch(acct, id) {
  const m = await api(acct, `${GM}/messages/${id}?format=full`);
  const labels = m.labelIds || [];
  if (!labels.includes("INBOX") && !labels.includes("SENT")) return null;
  const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  return {
    extId: m.id, threadId: m.threadId, folder: labels.includes("SENT") ? "sent" : "inbox", read: !labels.includes("UNREAD"),
    from: parseAddress(h.from || ""), to: h.to || "", subject: h.subject || "", ts: Number(m.internalDate) || Date.now(),
    body: gmailBody(m.payload) || m.snippet || "",
  };
}

async function gmailSync(acct, user, settings) {
  let state = acct.mail_state || {};
  let ids = [];
  if (state.historyId) {
    try {
      let pageToken, newest = state.historyId;
      do {
        const p = new URLSearchParams({ startHistoryId: state.historyId, historyTypes: "messageAdded", maxResults: "200" });
        if (pageToken) p.set("pageToken", pageToken);
        const h = await api(acct, `${GM}/history?${p}`);
        (h.history || []).forEach((x) => (x.messagesAdded || []).forEach((a) => ids.push(a.message.id)));
        newest = h.historyId || newest; pageToken = h.nextPageToken;
      } while (pageToken);
      state = { ...state, historyId: newest };
    } catch (e) {
      if (e.status !== 404) throw e;
      state = {}; // history expired; fall through to a short re-import
    }
  }
  if (!state.historyId) {
    const prof = await api(acct, `${GM}/profile`);
    const q = `newer_than:${state.reset ? 2 : DAYS_BACK}d (in:inbox OR in:sent) -category:promotions -category:social`;
    let pageToken, n = 0;
    do {
      const p = new URLSearchParams({ q, maxResults: "100" });
      if (pageToken) p.set("pageToken", pageToken);
      const list = await api(acct, `${GM}/messages?${p}`);
      (list.messages || []).forEach((m) => ids.push(m.id));
      pageToken = list.nextPageToken; n++;
    } while (pageToken && n < 5);
    state = { historyId: prof.historyId };
  }
  let added = 0;
  for (const id of [...new Set(ids)].reverse()) {
    try { const m = await gmailFetch(acct, id); if (m && (await ingest(acct, user, settings, m))) added++; } catch (e) { if (e.status !== 404) throw e; }
  }
  return { state, added };
}

const b64h = (s) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
async function gmailSend(acct, { to, subject, body, fromName, inReplyTo, threadId }) {
  const lines = [
    `From: ${fromName ? b64h(fromName) + " " : ""}<${acct.email}>`, `To: ${to}`, `Subject: ${b64h(subject)}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []), "",
    Buffer.from(body, "utf8").toString("base64"),
  ];
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const r = await api(acct, `${GM}/messages/send`, { method: "POST", body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) });
  return { extId: r.id, threadId: r.threadId };
}

/* ---------------- Microsoft Graph ---------------- */
const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "subject,from,toRecipients,receivedDateTime,sentDateTime,body,isRead,conversationId";

async function graphFolderSync(acct, user, settings, folder, link) {
  const since = new Date(Date.now() - DAYS_BACK * 864e5).toISOString();
  let url = link || `${GRAPH}/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=receivedDateTime+ge+${since}`;
  let added = 0, pages = 0, delta = null;
  while (url && pages < 10) {
    const r = await api(acct, url, { headers: { Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' } });
    for (const m of r.value || []) {
      if (m["@removed"]) continue;
      const msg = {
        extId: m.id, threadId: m.conversationId, folder: folder === "sentitems" ? "sent" : "inbox", read: !!m.isRead,
        from: { name: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "", email: (m.from?.emailAddress?.address || "").toLowerCase() },
        to: (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean).join(", "),
        subject: m.subject || "", ts: new Date(m.receivedDateTime || m.sentDateTime || Date.now()).getTime(),
        body: m.body?.contentType === "html" ? stripHtml(m.body.content) : m.body?.content || "",
      };
      if (await ingest(acct, user, settings, msg)) added++;
    }
    delta = r["@odata.deltaLink"] || null;
    url = r["@odata.nextLink"] || null;
    pages++;
  }
  return { link: delta || url, added }; // if pages ran out, resume from nextLink next time
}

async function graphSync(acct, user, settings) {
  const state = { ...(acct.mail_state || {}) };
  const a = await graphFolderSync(acct, user, settings, "inbox", state.inbox);
  const b = await graphFolderSync(acct, user, settings, "sentitems", state.sent);
  return { state: { inbox: a.link, sent: b.link }, added: a.added + b.added };
}

async function graphSend(acct, { to, subject, body }) {
  await api(acct, `${GRAPH}/me/sendMail`, {
    method: "POST",
    body: JSON.stringify({ message: { subject, body: { contentType: "Text", content: body }, toRecipients: String(to).split(",").map((a) => ({ emailAddress: { address: a.trim() } })) }, saveToSentItems: true }),
  });
  return { extId: null };
}

/* ---------------- public API ---------------- */
async function syncMail(acct) {
  const user = await db("users").where({ id: acct.user_id }).first();
  const org = await db("orgs").where({ id: acct.org_id }).first();
  const settings = org?.settings || {};
  try {
    const { state, added } = acct.provider === "google" ? await gmailSync(acct, user, settings) : await graphSync(acct, user, settings);
    await db("oauth_accounts").where({ id: acct.id }).update({ mail_state: state, last_mail_sync_at: db.fn.now(), last_error: null });
    return added;
  } catch (e) {
    await db("oauth_accounts").where({ id: acct.id }).update({ last_error: `Mail: ${e.message}`.slice(0, 500), last_mail_sync_at: db.fn.now() });
    throw e;
  }
}

async function sendMail(acct, msg) {
  return acct.provider === "google" ? gmailSend(acct, msg) : graphSend(acct, msg);
}

module.exports = { syncMail, sendMail, parseAddress, stripHtml };
