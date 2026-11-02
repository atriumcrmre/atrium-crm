/**
 * Tests the provider integrations against in-process mocks of their APIs (no network):
 * Gmail, Microsoft Graph mail, Google Calendar, SendGrid (send + event webhook), Netlify
 * deploys, DocuSign (JWT + envelope) and Bridge MLS. Run: node scripts/provider-test.js
 * Uses DATABASE_URL from .env and creates a throwaway org.
 */
require("dotenv").config();
process.env.SENDGRID_API_KEY = "SG.test"; process.env.SENDGRID_FROM_EMAIL = "news@example.com";
process.env.NETLIFY_AUTH_TOKEN = "nf-test";
process.env.GEMINI_API_KEY = "g-test"; process.env.AI_PROVIDER = "gemini";
const crypto = require("crypto");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
Object.assign(process.env, { DOCUSIGN_INTEGRATION_KEY: "ik", DOCUSIGN_USER_ID: "uid", DOCUSIGN_ACCOUNT_ID: "acct-1", DOCUSIGN_PRIVATE_KEY: privateKey });

const db = require("../src/db");
const { encrypt } = require("../src/lib/crypto");
const { putRecord, listRecords } = require("../src/lib/records");
let pass = 0, fail = 0;
const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

/* ---------- fetch mock ---------- */
const calls = [];
const b64u = (s) => Buffer.from(s).toString("base64url");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const routes = [
  [/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/, () => json({ historyId: "100" })],
  [/gmail.*\/messages\?/, () => json({ messages: [{ id: "g1" }, { id: "g2" }] })],
  [/gmail.*\/history\?/, () => json({ historyId: "120", history: [{ messagesAdded: [{ message: { id: "g3" } }] }] })],
  [/gmail.*\/messages\/send/, () => json({ id: "gsent1", threadId: "t9" })],
  [/gmail.*\/messages\/(g\d)\?format=full/, (u, m) => {
    const id = m[1];
    const d = { g1: ["Amelia Hart <amelia@example.com>", "INBOX", "Offer on Juniper"], g2: ["Stranger <x@y.com>", "INBOX", "Hello"], g3: ["Amelia Hart <amelia@example.com>", "INBOX,UNREAD", "Follow up"] }[id];
    return json({ id, threadId: "t" + id, labelIds: d[1].split(","), internalDate: String(Date.now()), snippet: "snip",
      payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: d[0] }, { name: "To", value: "sara@example.com" }, { name: "Subject", value: d[2] }], parts: [{ mimeType: "text/plain", body: { data: b64u("Body of " + d[2]) } }] } });
  }],
  [/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta/, () => json({ value: [{ id: "AAMk=1/x", subject: "Lease redlines", from: { emailAddress: { name: "Elena", address: "elena@northwind.example" } }, toRecipients: [{ emailAddress: { address: "sara@example.com" } }], receivedDateTime: new Date().toISOString(), body: { contentType: "text", content: "See attached" }, isRead: false, conversationId: "c1" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc" })],
  [/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/sentitems/, () => json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/delta-sent" })],
  [/googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?sendUpdates/, (u, m, init) => { const b = JSON.parse(init.body); return json({ id: "gev2", summary: b.summary, start: b.start, end: b.end, hangoutLink: "https://meet.google.com/x", attendees: b.attendees }); }],
  [/googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/, () => json({ items: [{ id: "gev1", status: "confirmed", summary: "Showing with Amelia", start: { dateTime: new Date(Date.now() + 864e5).toISOString() }, end: { dateTime: new Date(Date.now() + 864e5 + 36e5).toISOString() }, attendees: [{ email: "amelia@example.com" }] }], nextSyncToken: "sync1" })],
  [/api\.sendgrid\.com\/v3\/mail\/send/, () => new Response("", { status: 202 })],
  [/api\.netlify\.com\/api\/v1\/sites$/, () => json({ id: "site1", ssl_url: "https://smoke-realty.netlify.app", name: "smoke-realty" })],
  [/api\.netlify\.com\/api\/v1\/sites\/site1\/deploys/, (u, m, init) => { const files = JSON.parse(init.body).files; return json({ id: "dep1", required: Object.values(files) }); }],
  [/api\.netlify\.com\/api\/v1\/sites\/site1$/, () => json({ id: "site1", ssl_url: "https://smoke-realty.netlify.app" })],
  [/api\.netlify\.com\/api\/v1\/deploys\/dep1\/files/, () => json({})],
  [/account-d\.docusign\.com\/oauth\/token/, (u, m, init) => { const a = new URLSearchParams(init.body).get("assertion"); return a.split(".").length === 3 ? json({ access_token: "ds-token", expires_in: 3600 }) : json({ error: "bad" }, 400); }],
  [/account-d\.docusign\.com\/oauth\/userinfo/, () => json({ accounts: [{ account_id: "acct-1", base_uri: "https://demo.docusign.net", is_default: true }] })],
  [/demo\.docusign\.net\/restapi\/v2\.1\/accounts\/acct-1\/envelopes/, (u, m, init) => { const b = JSON.parse(init.body); return json({ envelopeId: "env-123", status: b.status }); }],
  [/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/, (u, m, init) => {
    const b = JSON.parse(init.body);
    const last = b.contents[b.contents.length - 1];
    if (last.parts.some((p) => p.functionResponse)) return json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Created the deal for Priya at $525,000." }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9 } });
    return json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { id: "fc-1", name: "create_record", args: { object: "deal", fields: "{\"name\":\"Raman – Halcyon\",\"amount\":525000}" } }, thoughtSignature: "sig-abc" }] } }] });
  }],
  [/api\.bridgedataoutput\.com/, () => json({ value: [{ ListingKey: "LK1", ListingId: "MLS9", UnparsedAddress: "4108 Juniper Ridge", City: "Austin", PropertySubType: "Single Family Residence", BedroomsTotal: 4, BathroomsTotalInteger: 3, LivingArea: 3120, ListPrice: 829000, StandardStatus: "Active", DaysOnMarket: 12 }] })],
];
global.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, init });
  for (const [re, fn] of routes) { const m = url.match(re); if (m) return fn(url, m, init); }
  return json({ error: { message: "unmocked " + url } }, 500);
};

(async () => {
  const [org] = await db("orgs").insert({ name: "Smoke Realty", public_id: "pt" + Date.now().toString(36), settings: { logAuto: true } }).returning("*");
  const [user] = await db("users").insert({ org_id: org.id, email: `pt${Date.now()}@example.com`, name: "Sara Khan" }).returning("*");
  await putRecord(org.id, "res", "contacts", { id: "amel", first: "Amelia", last: "Hart", email: "amelia@example.com", type: "Buyer", lifecycle: "Lead", lastAct: 0, created: Date.now() });
  await putRecord(org.id, "com", "contacts", { id: "elen", first: "Elena", last: "V", email: "elena@northwind.example", type: "Tenant", lifecycle: "Lead", lastAct: 0, created: Date.now() });
  const mk = async (provider) => (await db("oauth_accounts").insert({ user_id: user.id, org_id: org.id, provider, provider_user_id: provider + "1", email: "sara@example.com", access_token_enc: encrypt("tok"), refresh_token_enc: encrypt("ref"), expires_at: new Date(Date.now() + 36e5), mail_enabled: true, cal_enabled: true }).returning("*"))[0];

  const { syncMail, sendMail } = require("../src/services/mail");
  const { syncCalendar, createEvent } = require("../src/services/calendar");

  // Gmail
  let g = await mk("google");
  let added = await syncMail(g);
  let mail = await listRecords(org.id, { type: "mail" });
  ok(added === 2 && mail.find((m) => m.subject === "Offer on Juniper")?.contact === "amel", "Gmail initial import + contact match");
  ok(mail.find((m) => m.subject === "Hello")?.contact === null, "Gmail unknown sender kept as not-in-CRM");
  g = await db("oauth_accounts").where({ id: g.id }).first();
  added = await syncMail(g);
  mail = await listRecords(org.id, { type: "mail" });
  const g3 = mail.find((m) => m.subject === "Follow up");
  ok(added === 1 && g3 && g3.read === false && g3.body === "Body of Follow up", "Gmail incremental (historyId) sync", `historyId=${(await db("oauth_accounts").where({ id: g.id }).first()).mail_state.historyId}`);
  const acts = await listRecords(org.id, { type: "acts" });
  ok(acts.filter((a) => a.kind === "email" && a.refs.contact.includes("amel")).length === 2, "emails auto-logged to contact timeline");
  const sent = await sendMail(g, { to: "amelia@example.com", subject: "Comps", body: "Here you go", fromName: "Sara Khan" });
  const raw = Buffer.from(JSON.parse(calls.filter((c) => /messages\/send/.test(c.url)).pop().init.body).raw, "base64url").toString();
  ok(sent.extId === "gsent1" && /To: amelia@example.com/.test(raw) && raw.includes(Buffer.from("Here you go").toString("base64")), "Gmail send builds MIME");

  // Google Calendar
  await syncCalendar(g);
  let evs = await listRecords(org.id, { type: "events" });
  ok(evs.length === 1 && evs[0].contact === "amel" && evs[0].source === "Google Calendar", "Google Calendar sync + attendee match");
  const ev = await createEvent(g, user, "res", { title: "Listing presentation", start: Date.now() + 2 * 864e5, dur: 45, loc: "Google Meet" }, { id: "amel", email: "amelia@example.com" });
  const evBody = JSON.parse(calls.filter((c) => /sendUpdates/.test(c.url)).pop().init.body);
  ok(ev.ext.id === "gev2" && evBody.conferenceData && evBody.attendees[0].email === "amelia@example.com", "Google Calendar create with Meet + invite");

  // Microsoft Graph mail
  const m = await mk("microsoft");
  added = await syncMail(m);
  mail = await listRecords(org.id, { type: "mail" });
  const ms = mail.find((x) => x.subject === "Lease redlines");
  ok(added === 1 && ms?.contact === "elen" && ms._unit === "com", "Outlook delta sync routes to Commercial contact");

  // SendGrid
  const sg = require("../src/services/sendgrid");
  await putRecord(org.id, "res", "emails", { id: "em1", name: "Weekend", subject: "Hi {first_name}", preheader: "p", list: "Active buyers", status: "Draft", blocks: [{ type: "heading", text: "Hello {first_name}" }, { type: "button", text: "RSVP", url: "/open-house" }] });
  const out = await sg.sendCampaignEmail(org, "res", "em1", { siteBase: "https://smoke-realty.netlify.app" });
  const sgBody = JSON.parse(calls.filter((c) => /sendgrid/.test(c.url)).pop().init.body);
  ok(out.recipients === 1 && sgBody.personalizations[0].substitutions["-first_name-"] === "Amelia" && sgBody.content[1].value.includes("https://smoke-realty.netlify.app/open-house") && sgBody.personalizations[0].headers["List-Unsubscribe"], "SendGrid send: personalization, links, unsubscribe header");
  await sg.handleEvents([{ event: "delivered", email: "amelia@example.com", atrium_org: org.public_id, atrium_email: "em1", timestamp: Date.now() / 1000 }, { event: "open", email: "amelia@example.com", atrium_org: org.public_id, atrium_email: "em1", timestamp: Date.now() / 1000 }]);
  const em = (await listRecords(org.id, { type: "emails" })).find((e) => e.id === "em1");
  ok(em.status === "Sent" && em.openRate === 100, "SendGrid events update open rate", `open ${em.openRate}%`);
  await sg.handleEvents([{ event: "unsubscribe", email: "amelia@example.com", atrium_org: org.public_id, atrium_email: "em1" }]);
  ok((await sg.recipients(org.id, "res", "Active buyers")).length === 0, "unsubscribed contacts are excluded");

  // Netlify
  await putRecord(org.id, "res", "forms", { id: "f1", name: "RSVP", fields: [{ label: "Email", type: "email", required: true }] });
  await putRecord(org.id, "res", "pages", { id: "p1", name: "Open House", slug: "open-house", status: "Published", form: "f1", headline: "Four homes", sub: "This weekend", bullets: ["a"], cta: "RSVP", hue: 170 });
  const nf = require("../src/services/netlify");
  const dep = await nf.deployPages(org);
  const uploaded = calls.filter((c) => /deploys\/dep1\/files/.test(c.url)).map((c) => c.url.split("/files")[1]);
  const page = (await listRecords(org.id, { type: "pages" }))[0];
  const html = Buffer.from(calls.find((c) => /files\/open-house/.test(c.url)).init.body).toString();
  ok(dep.pages === 1 && uploaded.includes("/open-house/index.html") && page.url === "https://smoke-realty.netlify.app/open-house/", "Netlify deploy uploads pages and stores URL");
  ok(html.includes(`/public/forms/${org.public_id}/f1`) && html.includes("Four homes"), "landing page posts to the public form API");

  // DocuSign
  const ds = require("../src/services/docusign");
  const env = await ds.sendEnvelope(org, { unit: "res", dealId: "d1", subject: "Sign the offer", signer: { name: "Amelia", email: "amelia@example.com" }, pdfBase64: Buffer.from("%PDF-1.4").toString("base64") });
  const envBody = JSON.parse(calls.filter((c) => /envelopes/.test(c.url)).pop().init.body);
  ok(env.envelopeId === "env-123" && envBody.recipients.signers[0].email === "amelia@example.com" && envBody.eventNotification.url.includes(org.public_id), "DocuSign JWT auth + envelope with Connect callback");
  await ds.handleConnect(org.public_id, { event: "envelope-completed", data: { envelopeId: "env-123" } });
  ok((await db("envelopes").where({ envelope_id: "env-123" }).first()).status === "completed", "DocuSign Connect status update");

  // Bridge MLS
  await db("integrations").insert({ org_id: org.id, provider: "bridge", enabled: true, config_enc: require("../src/lib/crypto").encryptJson({ serverToken: "t", dataset: "actris" }) });
  const br = await require("../src/services/bridge").syncBridge(org.id);
  const prop = (await listRecords(org.id, { type: "properties" })).find((p) => p.mlsId === "MLS9");
  ok(br.listings === 1 && prop?.beds === 4 && prop.price === 829000, "Bridge MLS listings sync");

  // Gemini (Keystone AI)
  const ai = require("../src/services/ai");
  const tools = [{ name: "create_record", description: "Create a record", input_schema: { type: "object", properties: { object: { type: "string", enum: ["contact", "deal"] }, fields: { type: "object" } }, required: ["object", "fields"] } }];
  const msgs = [{ role: "user", content: "Create a deal for Priya at $525K" }];
  const t1 = await ai.complete({ system: "You are Keystone.", messages: msgs, tools, maxTokens: 2000 });
  const req1 = JSON.parse(calls.filter((c) => /generativelanguage/.test(c.url)).pop().init.body);
  const decl = req1.tools[0].functionDeclarations[0];
  ok(ai.provider() === "gemini" && decl.parameters.properties.fields.type === "STRING" && decl.parameters.properties.object.enum.length === 2 && req1.systemInstruction.parts[0].text === "You are Keystone.", "Gemini request: tools, schema and system prompt translated");
  const use = t1.content.find((b) => b.type === "tool_use");
  ok(t1.stop_reason === "tool_use" && use.input.fields.amount === 525000 && use._sig === "sig-abc", "Gemini function call → tool_use with parsed arguments");
  const t2 = await ai.complete({ system: "You are Keystone.", tools, maxTokens: 2000, messages: [...msgs, { role: "assistant", content: t1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ ok: true, id: "d9" }) }] }] });
  const req2 = JSON.parse(calls.filter((c) => /generativelanguage/.test(c.url)).pop().init.body);
  const fc = req2.contents[1].parts[0], fr = req2.contents[2].parts[0].functionResponse;
  ok(fc.thoughtSignature === "sig-abc" && fc.functionCall.id === "fc-1" && fr.name === "create_record" && fr.id === "fc-1" && fr.response.ok === true, "Gemini history: signature and call ids sent back");
  ok(t2.stop_reason === "end_turn" && t2.content[0].text.includes("525,000"), "Gemini final answer");

  await db("orgs").where({ id: org.id }).del();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await db.destroy(); process.exit(1); });
