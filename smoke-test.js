/**
 * End-to-end check against a running server: BASE=http://localhost:4000 npm run test:smoke
 * Creates a throwaway account and exercises accounts, sync, forms, Zillow, CoStar, the REST
 * API, webhooks and the "not configured" paths for SendGrid, Netlify, DocuSign and AI.
 */
const http = require("http");
const crypto = require("crypto");
const BASE = (process.env.BASE || "http://localhost:4000").replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); };

function client() {
  let cookie = "";
  return async (method, path, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const r = await fetch(BASE + path, {
      method, redirect: "manual",
      headers: { ...(cookie ? { Cookie: cookie } : {}), "X-Requested-With": "atrium", "X-Client-Id": "smoke", ...(body && !isForm ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc && sc.includes("atrium_session=")) cookie = sc.split(";")[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j, headers: r.headers };
  };
}

(async () => {
  // Local webhook receiver to verify signed deliveries.
  const got = [];
  const recv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ headers: req.headers, body: b }); res.end("ok"); }); }).listen(4555);

  const A = client();
  const email = `smoke+${Date.now()}@example.com`;
  let r = await A("POST", "/api/auth/register", { name: "Sara Khan", email, password: "correct horse battery", company: "Smoke Realty" });
  ok(r.status === 200, "register", r.body.error);
  r = await A("GET", "/api/me"); ok(r.status === 200 && r.body.user.email === email, "session /me");
  const orgPublic = r.body.org.publicId;

  r = await A("POST", "/api/sync", { changes: { res: {
    contacts: { upsert: [{ id: "c1", first: "Amelia", last: "Hart", email: "amelia@example.com", type: "Buyer", lifecycle: "Lead", score: 80, lastAct: Date.now(), created: Date.now() }] },
    deals: { upsert: [{ id: "d1", name: "Hart – Juniper", pipe: "buy", stage: "appt", amount: 829000, contacts: ["c1"], created: Date.now(), close: Date.now() }] },
    forms: { upsert: [{ id: "f1", name: "Open house RSVP", lifecycle: "Lead", notify: true, views: 0, submissions: 0, fields: [{ label: "First name", type: "text", required: true }, { label: "Email", type: "email", required: true }] }] },
    pages: { upsert: [{ id: "p1", name: "Open House", slug: "open-house", status: "Draft", form: "f1", headline: "Four open houses", sub: "Sat–Sun", bullets: ["a", "b", "c"], cta: "RSVP", hue: 170, views: 0, submissions: 0 }] },
    emails: { upsert: [{ id: "e1", name: "Weekend", subject: "Hi {first_name}", list: "Active buyers", status: "Draft", blocks: [{ type: "heading", text: "Hello {first_name}" }] }] },
  } } });
  ok(r.status === 200 && r.body.upserts === 5, "sync upserts", JSON.stringify(r.body));

  r = await A("GET", "/api/workspace");
  ok(r.body.data?.res?.contacts?.length === 1 && r.body.data.res.deals[0].amount === 829000, "workspace load");

  // Webhook on deal stage change
  r = await A("POST", "/api/webhooks", { url: "http://localhost:4555/hook", event: "deal.stage_changed" });
  ok(r.status === 200 && r.body.secret, "create webhook");
  const secret = r.body.secret;
  await A("POST", "/api/sync", { changes: { res: { deals: { upsert: [{ id: "d1", name: "Hart – Juniper", pipe: "buy", stage: "offer", amount: 829000, contacts: ["c1"], created: Date.now(), close: Date.now() }] } } } });
  await new Promise((s) => setTimeout(s, 800));
  const hook = got.find((g) => g.headers["x-atrium-event"] === "deal.stage_changed");
  const sigOk = hook && hook.headers["x-atrium-signature"] === "sha256=" + crypto.createHmac("sha256", secret).update(`${hook.headers["x-atrium-timestamp"]}.${hook.body}`).digest("hex");
  ok(!!hook && sigOk && JSON.parse(hook.body).data.to === "offer", "signed webhook delivered");

  // Changes feed hides own writes, shows others'
  r = await A("GET", "/api/changes?since=0", null, { "X-Client-Id": "other-tab" });
  ok(r.body.records?.length >= 5, "changes feed", `${r.body.records?.length} records`);

  // Public form submission (as a landing page would)
  r = await fetch(`${BASE}/public/forms/${orgPublic}/f1?page=p1&unit=res`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.netlify.app" }, body: JSON.stringify({ "First name": "Riley", Email: "riley@example.com" }) });
  ok(r.status === 200 && r.headers.get("access-control-allow-origin") === "*", "public form submit + CORS");
  r = await fetch(`${BASE}/public/forms/${orgPublic}/f1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "First name": "" }) });
  ok(r.status === 400, "form validation");
  r = await A("GET", "/api/workspace");
  const riley = r.body.data.res.contacts.find((c) => c.email === "riley@example.com");
  ok(!!riley && r.body.data.res.forms[0].submissions === 1 && r.body.data.res.tasks.length === 1 && r.body.data.res.pages[0].submissions === 1, "form → contact, task, counters");

  // Zillow
  r = await A("PUT", "/api/integrations/zillow", { config: {} });
  r = await A("GET", "/api/integrations");
  const zurl = r.body.zillow.webhookUrl.replace(/^https?:\/\/[^/]+/, BASE);
  r = await fetch(zurl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lead: { contact: { firstName: "Jordan", lastName: "Lee", email: "jordan@example.com", phone: "512-555-0100" }, listing: { address: "9 Willow Bend", city: "Cedar Park", price: 615000, zpid: "123" }, message: "Is it available?" } }) });
  const zj = await r.json();
  ok(r.status === 200 && zj.created && zj.dealId, "Zillow lead → contact + deal");
  r = await fetch(zurl.replace(/secret=[^&]+/, "secret=wrong"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  ok(r.status === 401, "Zillow bad secret rejected");

  // CoStar CSV
  const fd = new FormData();
  fd.append("file", new Blob(["Tenant Name,SF Occupied,Lease Expiration,Industry,City,Contact Name,Contact Email\nNorthwind Logistics,\"48,000\",2027-06-30,Logistics,Dallas,Elena Vasquez,elena@northwind.example\nBloom Dental,3200,2027-02-01,Healthcare,Plano,,\n"], { type: "text/csv" }), "tenants.csv");
  r = await A("POST", "/api/integrations/costar/import", fd);
  ok(r.status === 200 && r.body.kind === "tenants" && r.body.created === 2 && r.body.contacts === 1, "CoStar tenant import", JSON.stringify(r.body));
  const fd2 = new FormData();
  fd2.append("file", new Blob(["Property Address,Property Type,RBA,Rent/SF/Yr,Percent Leased,City\n2100 Ross Ave,Office,\"420,000\",$38.50,76%,Dallas\n"], { type: "text/csv" }), "props.csv");
  r = await A("POST", "/api/integrations/costar/import", fd2);
  ok(r.status === 200 && r.body.kind === "properties" && r.body.created === 1, "CoStar property import");
  r = await A("GET", "/api/workspace");
  const nw = r.body.data.com.companies.find((c) => c.name === "Northwind Logistics");
  ok(nw && nw.sf === 48000 && nw.expiry > 0, "CoStar fields mapped");

  // REST API v1
  r = await A("POST", "/api/api-keys", { name: "Smoke" });
  const key = r.body.key; ok(/^atr_live_/.test(key || ""), "API key issued");
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  r = await fetch(`${BASE}/v1/objects/contacts?unit=res`, { headers: H }); let j = await r.json();
  ok(r.status === 200 && j.results.length >= 3, "v1 list contacts", `${j.results?.length}`);
  r = await fetch(`${BASE}/v1/objects/contacts`, { method: "POST", headers: H, body: JSON.stringify({ unit: "res", properties: { first: "Api", last: "Person", email: "api@example.com" } }) }); j = await r.json();
  ok(r.status === 201 && j.id, "v1 create contact");
  r = await fetch(`${BASE}/v1/objects/contacts/${j.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ properties: { lifecycle: "Customer" } }) }); j = await r.json();
  ok(j.properties?.lifecycle === "Customer", "v1 update contact");
  r = await fetch(`${BASE}/v1/search?q=Northwind`, { headers: H }); j = await r.json();
  ok(j.results?.some((x) => x.type === "companies"), "v1 search");
  r = await fetch(`${BASE}/v1/objects/contacts`, { headers: { Authorization: "Bearer nope" } });
  ok(r.status === 401, "v1 rejects bad key");

  // Configuration-dependent features report clearly when not configured
  r = await A("GET", "/api/marketing/lists?unit=res"); ok(r.status === 200 && typeof r.body.lists["Active buyers"] === "number", "marketing list counts", JSON.stringify(r.body.lists));
  r = await A("POST", "/api/marketing/emails/e1/send", { unit: "res" }); ok(r.status === 503 || r.status === 200, "marketing send (needs SendGrid)", r.body.error || "sent");
  r = await A("POST", "/api/pages/p1/publish", { unit: "res", publish: true }); ok(r.status === 503 || r.status === 200, "publish page (needs Netlify)", r.body.error || r.body.url);
  r = await A("POST", "/api/docusign/envelopes", { dealId: "d1", unit: "res", signerEmail: "amelia@example.com", signerName: "Amelia" }); ok(r.status === 503 || r.status === 200, "DocuSign envelope (needs DocuSign)", r.body.error || r.body.envelopeId);
  r = await A("POST", "/api/ai/messages", { messages: [{ role: "user", content: "hi" }] }); ok(r.status === 503 || r.status === 200, "Keystone AI (needs a Gemini or Claude key)", r.body.error || "answered");
  r = await A("POST", "/api/mail/send", { to: "a@b.com", subject: "x", body: "y", unit: "res" }); ok(r.status === 400, "mail send requires connected inbox", r.body.error);
  r = await A("POST", "/api/calendar/events", { title: "Showing", start: Date.now() + 864e5, dur: 30, contactId: "c1", unit: "res" }); ok(r.status === 200 && r.body.event?.id, "meeting saved (local calendar when none connected)");
  r = await A("GET", "/api/oauth/google/start?purpose=login"); ok(r.status === 302, "Google sign-in route", r.headers.get("location")?.slice(0, 60));

  // CSRF guard, invites, login/logout
  r = await fetch(`${BASE}/api/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); ok(r.status === 401 || r.status === 403, "unauthenticated write blocked");
  r = await A("POST", "/api/members/invite", { email: `mate+${Date.now()}@example.com`, role: "member" });
  const inviteTok = new URL(r.body.link).searchParams.get("invite"); const mateEmail = decodeURIComponent(r.body.link) && (await A("GET", `/api/auth/invite/${inviteTok}`)).body.email;
  const B = client();
  r = await B("POST", "/api/auth/register", { name: "Omar", email: mateEmail, password: "another long password", invite: inviteTok });
  ok(r.status === 200, "invite accepted");
  r = await B("GET", "/api/workspace"); ok(r.body.data?.res?.contacts?.length >= 3, "teammate sees shared workspace");
  r = await A("POST", "/api/auth/logout"); r = await A("GET", "/api/me"); ok(r.status === 401, "logout");
  r = await A("POST", "/api/auth/login", { email, password: "correct horse battery" }); ok(r.status === 200, "login");

  recv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
