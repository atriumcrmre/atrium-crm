/**
 * Google Calendar and Outlook Calendar two-way sync.
 * Google uses syncToken; Graph uses calendarView delta links. Events created in Atrium
 * are written to the provider first, so they come back with a provider id.
 */
const db = require("../db");
const { api } = require("./oauth");
const { sha1, randomToken } = require("../lib/crypto");
const { putRecord, deleteRecord, findByExt, findContactByEmail, addActivity } = require("../lib/records");

const GCAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GRAPH = "https://graph.microsoft.com/v1.0";
const recId = (key) => "e" + sha1(key).slice(0, 16);

async function storeEvent(acct, user, ev) {
  const key = `${acct.provider}:${ev.extId}`;
  const prev = await findByExt(acct.org_id, "events", key);
  if (ev.cancelled) { if (prev && !prev.deleted) await deleteRecord(acct.org_id, "events", prev.data.id); return; }
  let contactHit = null;
  for (const e of ev.attendees || []) { if (e.toLowerCase() === acct.email.toLowerCase()) continue; contactHit = await findContactByEmail(acct.org_id, e); if (contactHit) break; }
  const unit = prev?.unit || contactHit?.unit || user.default_unit || "res";
  const rec = {
    ...(prev?.data || {}),
    id: prev?.data.id || recId(key),
    title: ev.title || "(no title)", start: ev.start, dur: ev.dur, loc: ev.loc || "",
    contact: prev?.data.contact || contactHit?.data.id || null, kind: prev?.data.kind || "Meeting",
    source: acct.provider === "google" ? "Google Calendar" : "Outlook Calendar",
    ext: { key, provider: acct.provider, id: ev.extId, account: acct.email, link: ev.link || null },
  };
  await putRecord(acct.org_id, unit, "events", rec, { extKey: key });
  if (!prev && contactHit) await addActivity(acct.org_id, unit, { kind: "meeting", title: rec.title, body: `${new Date(rec.start).toUTCString()} · ${rec.loc}`, refs: { contact: [contactHit.data.id] }, extra: { eventId: rec.id } });
}

/* -------- Google -------- */
function gEvent(e) {
  const s = e.start?.dateTime || e.start?.date, en = e.end?.dateTime || e.end?.date;
  const start = s ? new Date(s).getTime() : Date.now();
  return {
    extId: e.id, cancelled: e.status === "cancelled", title: e.summary, start,
    dur: en ? Math.max(15, Math.round((new Date(en).getTime() - start) / 60000)) : 60,
    loc: e.location || (e.hangoutLink ? "Google Meet" : ""), link: e.hangoutLink || e.htmlLink,
    attendees: (e.attendees || []).map((a) => a.email).filter(Boolean),
  };
}
async function googleSync(acct, user) {
  let state = acct.cal_state || {};
  const run = async (initial) => {
    let pageToken, next = null;
    do {
      const p = new URLSearchParams({ singleEvents: "true", maxResults: "250", showDeleted: "true" });
      if (initial) p.set("timeMin", new Date(Date.now() - 30 * 864e5).toISOString()); else p.set("syncToken", state.syncToken);
      if (pageToken) p.set("pageToken", pageToken);
      const r = await api(acct, `${GCAL}?${p}`);
      for (const e of r.items || []) await storeEvent(acct, user, gEvent(e));
      pageToken = r.nextPageToken; next = r.nextSyncToken || next;
    } while (pageToken);
    return next;
  };
  try { state = { syncToken: await run(!state.syncToken) }; }
  catch (e) { if (e.status !== 410) throw e; state = { syncToken: await run(true) }; }
  return state;
}
async function googleCreate(acct, ev, attendeeEmail) {
  const meet = /meet/i.test(ev.loc || "");
  const body = {
    summary: ev.title, location: meet ? undefined : ev.loc,
    start: { dateTime: new Date(ev.start).toISOString() }, end: { dateTime: new Date(ev.start + ev.dur * 60000).toISOString() },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    ...(meet ? { conferenceData: { createRequest: { requestId: randomToken(9), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
  };
  const r = await api(acct, `${GCAL}?sendUpdates=all&conferenceDataVersion=1`, { method: "POST", body: JSON.stringify(body) });
  return gEvent(r);
}
const googleDelete = (acct, id) => api(acct, `${GCAL}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE" });

/* -------- Microsoft -------- */
function msEvent(e) {
  const start = e.start?.dateTime ? new Date(e.start.dateTime + "Z").getTime() : Date.now();
  const end = e.end?.dateTime ? new Date(e.end.dateTime + "Z").getTime() : start + 3600000;
  return {
    extId: e.id, cancelled: !!e["@removed"] || e.isCancelled, title: e.subject, start, dur: Math.max(15, Math.round((end - start) / 60000)),
    loc: e.location?.displayName || (e.isOnlineMeeting ? "Microsoft Teams" : ""), link: e.onlineMeeting?.joinUrl || e.webLink,
    attendees: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
  };
}
async function graphSync(acct, user) {
  const state = acct.cal_state || {};
  const from = new Date(Date.now() - 30 * 864e5).toISOString(), to = new Date(Date.now() + 180 * 864e5).toISOString();
  let url = state.link || `${GRAPH}/me/calendarView/delta?startDateTime=${from}&endDateTime=${to}`;
  let pages = 0, link = null;
  while (url && pages < 20) {
    const r = await api(acct, url, { headers: { Prefer: 'outlook.timezone="UTC", odata.maxpagesize=100' } });
    for (const e of r.value || []) await storeEvent(acct, user, msEvent(e));
    link = r["@odata.deltaLink"] || null; url = r["@odata.nextLink"] || null; pages++;
  }
  return { link: link || url };
}
async function graphCreate(acct, ev, attendeeEmail) {
  const teams = /teams/i.test(ev.loc || "");
  const r = await api(acct, `${GRAPH}/me/events`, {
    method: "POST", headers: { Prefer: 'outlook.timezone="UTC"' },
    body: JSON.stringify({
      subject: ev.title, location: { displayName: ev.loc || "" },
      start: { dateTime: new Date(ev.start).toISOString().slice(0, 19), timeZone: "UTC" }, end: { dateTime: new Date(ev.start + ev.dur * 60000).toISOString().slice(0, 19), timeZone: "UTC" },
      attendees: attendeeEmail ? [{ emailAddress: { address: attendeeEmail }, type: "required" }] : [],
      ...(teams ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
    }),
  });
  return msEvent(r);
}
const graphDelete = (acct, id) => api(acct, `${GRAPH}/me/events/${encodeURIComponent(id)}`, { method: "DELETE" });

/* -------- public -------- */
async function syncCalendar(acct) {
  const user = await db("users").where({ id: acct.user_id }).first();
  try {
    const state = acct.provider === "google" ? await googleSync(acct, user) : await graphSync(acct, user);
    await db("oauth_accounts").where({ id: acct.id }).update({ cal_state: state, last_cal_sync_at: db.fn.now(), last_error: null });
  } catch (e) {
    await db("oauth_accounts").where({ id: acct.id }).update({ last_error: `Calendar: ${e.message}`.slice(0, 500), last_cal_sync_at: db.fn.now() });
    throw e;
  }
}

/** Create on the provider, then store locally with the provider id. */
async function createEvent(acct, user, unit, ev, contact) {
  const created = acct.provider === "google" ? await googleCreate(acct, ev, contact?.email) : await graphCreate(acct, ev, contact?.email);
  const key = `${acct.provider}:${created.extId}`;
  const rec = { id: recId(key), title: ev.title, start: ev.start, dur: ev.dur, loc: created.loc || ev.loc, contact: contact?.id || null, kind: ev.kind || "Meeting", source: acct.provider === "google" ? "Google Calendar" : "Outlook Calendar", ext: { key, provider: acct.provider, id: created.extId, account: acct.email, link: created.link } };
  await putRecord(acct.org_id, unit, "events", rec, { extKey: key });
  return rec;
}

async function deleteProviderEvent(orgId, ext) {
  if (!ext?.provider || !ext.id) return;
  const acct = await db("oauth_accounts").where({ org_id: orgId, provider: ext.provider, email: ext.account, cal_enabled: true }).first();
  if (!acct) return;
  try { ext.provider === "google" ? await googleDelete(acct, ext.id) : await graphDelete(acct, ext.id); }
  catch (e) { if (![404, 410].includes(e.status)) console.error("calendar delete failed", e.message); }
}

module.exports = { syncCalendar, createEvent, deleteProviderEvent };
