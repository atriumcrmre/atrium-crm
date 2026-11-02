const db = require("../db");
const { config } = require("../config");
const { encrypt, decrypt } = require("../lib/crypto");

const SCOPES = {
  google: {
    login: ["openid", "email", "profile"],
    mail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    calendar: ["https://www.googleapis.com/auth/calendar.events"],
  },
  microsoft: {
    login: ["openid", "profile", "email", "offline_access", "User.Read"],
    mail: ["Mail.Read", "Mail.Send"],
    calendar: ["Calendars.ReadWrite"],
  },
};

function scopesFor(provider, purpose) {
  const s = SCOPES[provider];
  const list = [...s.login];
  if (purpose === "mail" || purpose === "both") list.push(...s.mail);
  if (purpose === "calendar" || purpose === "both") list.push(...s.calendar);
  return [...new Set(list)];
}

const redirectUri = (provider) => `${config.appUrl}/api/oauth/${provider}/callback`;

function isConfigured(provider) {
  const c = config[provider];
  return !!(c && c.clientId && c.clientSecret);
}

function authUrl(provider, { state, purpose, loginHint }) {
  const scope = scopesFor(provider, purpose).join(" ");
  if (provider === "google") {
    const p = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri("google"), response_type: "code", scope, state,
      access_type: "offline", include_granted_scopes: "true", prompt: purpose === "login" ? "select_account" : "consent",
    });
    if (loginHint) p.set("login_hint", loginHint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }
  const p = new URLSearchParams({ client_id: config.microsoft.clientId, redirect_uri: redirectUri("microsoft"), response_type: "code", response_mode: "query", scope, state, prompt: "select_account" });
  if (loginHint) p.set("login_hint", loginHint);
  return `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize?${p}`;
}

async function tokenRequest(provider, params) {
  const url = provider === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ client_id: config[provider].clientId, client_secret: config[provider].clientSecret, ...params });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${provider} token error: ${j.error_description || j.error || r.status}`);
  return j;
}

const exchangeCode = (provider, code, purpose) =>
  tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri(provider), ...(provider === "microsoft" ? { scope: scopesFor(provider, purpose).join(" ") } : {}) });

async function profile(provider, accessToken) {
  if (provider === "google") {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await r.json();
    if (!r.ok) throw new Error("Google profile error");
    return { id: j.sub, email: j.email, name: j.name || j.email };
  }
  const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await r.json();
  if (!r.ok) throw new Error("Microsoft profile error");
  return { id: j.id, email: j.mail || j.userPrincipalName, name: j.displayName || j.mail };
}

/** Returns a valid access token for an oauth_accounts row, refreshing and persisting when needed. */
async function accessTokenFor(acct) {
  const exp = acct.expires_at ? new Date(acct.expires_at).getTime() : 0;
  if (acct.access_token_enc && exp - Date.now() > 120000) return decrypt(acct.access_token_enc);
  const refresh = decrypt(acct.refresh_token_enc);
  if (!refresh) throw new Error("No refresh token. Reconnect this account.");
  const scope = acct.scopes || "";
  const t = await tokenRequest(acct.provider, { grant_type: "refresh_token", refresh_token: refresh, ...(acct.provider === "microsoft" ? { scope } : {}) });
  const upd = { access_token_enc: encrypt(t.access_token), expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000), updated_at: db.fn.now() };
  if (t.refresh_token) upd.refresh_token_enc = encrypt(t.refresh_token);
  await db("oauth_accounts").where({ id: acct.id }).update(upd);
  Object.assign(acct, upd);
  return t.access_token;
}

/** fetch() against Google/Graph with the account's token; throws with the API's message on failure. */
async function api(acct, url, opts = {}) {
  const token = await accessTokenFor(acct);
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body && typeof opts.body === "string" ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
  if (r.status === 204) return {};
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error(j.error?.message || j.error_description || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

module.exports = { SCOPES, scopesFor, isConfigured, authUrl, exchangeCode, profile, accessTokenFor, api };
