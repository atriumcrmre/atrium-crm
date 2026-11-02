const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { config } = require("../config");
const { setSession, clearSession, requireUser, requireRole, publicUser, loadUser } = require("../lib/auth");
const { randomToken, encrypt } = require("../lib/crypto");
const oauth = require("../services/oauth");
const { syncAccount } = require("../services/worker");
const sendgrid = require("../services/sendgrid");
const docusign = require("../services/docusign");
const ai = require("../services/ai");

const r = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Try again in a few minutes." } });
const publicIdFor = () => randomToken(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 16).padEnd(16, "x");

async function createOrgAndUser({ name, email, password, company, invite }) {
  return db.transaction(async (trx) => {
    let orgId, role = "owner";
    if (invite) {
      const inv = await trx("invites").where({ token: invite }).whereNull("accepted_at").where("expires_at", ">", new Date()).first();
      if (!inv) throw Object.assign(new Error("This invite link is invalid or expired."), { status: 400 });
      if (inv.email.toLowerCase() !== email.toLowerCase()) throw Object.assign(new Error(`This invite is for ${inv.email}.`), { status: 400 });
      orgId = inv.org_id; role = inv.role;
      await trx("invites").where({ token: invite }).update({ accepted_at: trx.fn.now() });
    } else {
      if (!config.allowSignup) throw Object.assign(new Error("Sign-ups are closed. Ask an admin for an invite."), { status: 403 });
      const [org] = await trx("orgs").insert({ name: company || `${name.split(" ")[0]}'s brokerage`, public_id: publicIdFor(), settings: { logAuto: true, track: true, twoWay: true } }).returning("*");
      orgId = org.id;
    }
    const [user] = await trx("users").insert({ org_id: orgId, email: email.toLowerCase(), name, role, password_hash: password ? await bcrypt.hash(password, 12) : null }).returning("*");
    return user;
  });
}

const RegisterBody = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(200), password: z.string().min(10, "Use at least 10 characters.").max(200), company: z.string().trim().max(120).optional(), invite: z.string().max(64).optional() });
r.post("/auth/register", authLimiter, async (req, res) => {
  const p = RegisterBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  if (await db("users").where({ email: p.data.email.toLowerCase() }).first()) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
  try {
    const user = await createOrgAndUser(p.data);
    setSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.post("/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && (await db("users").where({ email: String(email).toLowerCase() }).first());
  if (!user || !user.password_hash || !(await bcrypt.compare(String(password || ""), user.password_hash))) return res.status(401).json({ error: "Email or password is incorrect." });
  await db("users").where({ id: user.id }).update({ last_login_at: db.fn.now() });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

r.post("/auth/logout", (req, res) => { clearSession(res); res.json({ ok: true }); });

r.get("/auth/providers", (req, res) => res.json({ google: oauth.isConfigured("google"), microsoft: oauth.isConfigured("microsoft"), signup: config.allowSignup }));

r.get("/auth/invite/:token", async (req, res) => {
  const inv = await db("invites").where({ token: req.params.token }).whereNull("accepted_at").where("expires_at", ">", new Date()).first();
  if (!inv) return res.status(404).json({ error: "This invite link is invalid or expired." });
  const org = await db("orgs").where({ id: inv.org_id }).first();
  res.json({ email: inv.email, orgName: org.name });
});

r.get("/me", requireUser, async (req, res) => {
  const org = await db("orgs").where({ id: req.orgId }).first();
  const members = await db("users").where({ org_id: req.orgId }).select("id", "name", "email", "role").orderBy("name");
  const ds = await docusign.dsConfig(req.orgId);
  res.json({
    user: publicUser(req.user),
    org: { id: org.id, name: org.name, publicId: org.public_id, settings: org.settings },
    members,
    features: {
      googleSignIn: oauth.isConfigured("google"), microsoftSignIn: oauth.isConfigured("microsoft"),
      sendgrid: sendgrid.isConfigured(), docusign: docusign.isConfigured(ds), ai: ai.isConfigured(), aiProvider: ai.label(),
    },
  });
});

r.patch("/me", requireUser, async (req, res) => {
  const upd = {};
  if (typeof req.body.name === "string" && req.body.name.trim()) upd.name = req.body.name.trim().slice(0, 120);
  if (["res", "com"].includes(req.body.defaultUnit)) upd.default_unit = req.body.defaultUnit;
  if (Object.keys(upd).length) await db("users").where({ id: req.user.id }).update({ ...upd, updated_at: db.fn.now() });
  res.json({ ok: true });
});

r.patch("/org/settings", requireUser, async (req, res) => {
  const allowed = ["logAuto", "track", "twoWay", "flows", "custom", "ints"];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (req.body.name && ["owner", "admin"].includes(req.user.role)) await db("orgs").where({ id: req.orgId }).update({ name: String(req.body.name).slice(0, 120) });
  await db("orgs").where({ id: req.orgId }).update({ settings: db.raw("settings || ?::jsonb", [JSON.stringify(patch)]), updated_at: db.fn.now() });
  res.json({ ok: true });
});

r.post("/members/invite", requireUser, requireRole("owner", "admin"), async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (await db("users").where({ email }).first()) return res.status(409).json({ error: "That person already has an account." });
  const token = randomToken(24);
  await db("invites").insert({ token, org_id: req.orgId, email, role: ["admin", "member"].includes(req.body.role) ? req.body.role : "member", invited_by: req.user.id, expires_at: new Date(Date.now() + 14 * 864e5) });
  res.json({ link: `${config.appUrl}/login.html?invite=${token}`, expiresInDays: 14 });
});

r.delete("/members/:id", requireUser, requireRole("owner", "admin"), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
  await db("users").where({ id: req.params.id, org_id: req.orgId }).whereNot({ role: "owner" }).del();
  res.json({ ok: true });
});

/* ---------- Google / Microsoft OAuth: sign-in and mailbox/calendar connections ---------- */
r.get("/oauth/:provider/start", async (req, res) => {
  const provider = req.params.provider;
  if (!["google", "microsoft"].includes(provider)) return res.status(404).end();
  const purpose = ["login", "mail", "calendar", "both"].includes(req.query.purpose) ? req.query.purpose : "login";
  if (!oauth.isConfigured(provider)) return res.redirect(`/login.html?error=${encodeURIComponent(`${provider === "google" ? "Google" : "Microsoft"} sign-in isn't configured on this server yet.`)}`);
  const user = purpose === "login" ? null : await loadUser(req);
  if (purpose !== "login" && !user) return res.redirect("/login.html");
  const state = jwt.sign({ p: purpose, u: user?.id || null, i: req.query.invite || null, n: randomToken(8) }, config.sessionSecret, { expiresIn: "15m" });
  res.cookie("atrium_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https://"), maxAge: 15 * 60 * 1000, path: "/" });
  res.redirect(oauth.authUrl(provider, { state, purpose, loginHint: user?.email }));
});

r.get("/oauth/:provider/callback", async (req, res) => {
  const provider = req.params.provider;
  const fail = (msg) => res.redirect(`/login.html?error=${encodeURIComponent(msg)}`);
  try {
    if (req.query.error) return fail(String(req.query.error_description || req.query.error));
    if (!req.query.state || req.query.state !== req.cookies.atrium_oauth_state) return fail("Sign-in expired. Please try again.");
    res.clearCookie("atrium_oauth_state", { path: "/" });
    const st = jwt.verify(req.query.state, config.sessionSecret);
    const tok = await oauth.exchangeCode(provider, req.query.code, st.p);
    const prof = await oauth.profile(provider, tok.access_token);
    if (!prof.email) return fail("Your account didn't share an email address.");

    let user;
    if (st.p === "login") {
      user = await db("users").where({ email: prof.email.toLowerCase() }).first();
      if (!user) user = await createOrgAndUser({ name: prof.name, email: prof.email, password: null, invite: st.i });
      await db("users").where({ id: user.id }).update({ last_login_at: db.fn.now() });
    } else {
      user = await db("users").where({ id: st.u }).first();
      if (!user) return fail("Sign in again to connect this account.");
    }

    const existing = await db("oauth_accounts").where({ provider, provider_user_id: prof.id, user_id: user.id }).first();
    const grantedMail = st.p === "mail" || st.p === "both", grantedCal = st.p === "calendar" || st.p === "both";
    const row = {
      user_id: user.id, org_id: user.org_id, provider, provider_user_id: prof.id, email: prof.email,
      access_token_enc: encrypt(tok.access_token), expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000),
      scopes: tok.scope || oauth.scopesFor(provider, st.p).join(" "), updated_at: db.fn.now(), last_error: null,
      ...(tok.refresh_token ? { refresh_token_enc: encrypt(tok.refresh_token) } : {}),
      mail_enabled: grantedMail || existing?.mail_enabled || false, cal_enabled: grantedCal || existing?.cal_enabled || false,
    };
    let acct;
    if (existing) { await db("oauth_accounts").where({ id: existing.id }).update(row); acct = { ...existing, ...row }; }
    else [acct] = await db("oauth_accounts").insert(row).returning("*");

    setSession(res, user);
    if (st.p !== "login") {
      syncAccount(await db("oauth_accounts").where({ id: acct.id }).first()).catch((e) => console.error("initial sync", e.message));
      return res.redirect(`/app.html#${grantedMail ? "inbox" : "calendar"}`);
    }
    res.redirect("/app.html");
  } catch (e) {
    console.error("oauth callback", e);
    fail(e.message || "Sign-in failed.");
  }
});

module.exports = r;
