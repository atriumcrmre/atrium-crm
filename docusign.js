/**
 * DocuSign eSignature (REST v2.1) with JWT Grant. Sends offers, LOIs and leases for a deal
 * either from a DocuSign template or an uploaded PDF, and receives status through DocuSign
 * Connect (per-envelope eventNotification) so the deal timeline updates on its own.
 */
const jwt = require("jsonwebtoken");
const db = require("../db");
const { config } = require("../config");
const { decryptJson } = require("../lib/crypto");
const crypto = require("crypto");
const { getRecord, addActivity } = require("../lib/records");
const { emit } = require("../lib/webhooks");

let cache = { token: null, exp: 0, baseUri: null, accountId: null };

async function dsConfig(orgId) {
  const row = await db("integrations").where({ org_id: orgId, provider: "docusign" }).first();
  const cfg = row ? decryptJson(row.config_enc) : {};
  return {
    integrationKey: cfg.integrationKey || config.docusign.integrationKey, userId: cfg.userId || config.docusign.userId,
    accountId: cfg.accountId || config.docusign.accountId, privateKey: (cfg.privateKey || config.docusign.privateKey || "").replace(/\\n/g, "\n"),
    authServer: cfg.authServer || config.docusign.authServer, defaultTemplateId: cfg.defaultTemplateId || "", enabled: row ? row.enabled : !!config.docusign.integrationKey,
  };
}

const isConfigured = (c) => !!(c.integrationKey && c.userId && c.accountId && c.privateKey);

async function token(c) {
  if (cache.token && cache.exp - Date.now() > 60000 && cache.key === c.integrationKey) return cache;
  const assertion = jwt.sign({ iss: c.integrationKey, sub: c.userId, aud: c.authServer, scope: "signature impersonation" }, c.privateKey, { algorithm: "RS256", expiresIn: 3600 });
  const r = await fetch(`https://${c.authServer}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const consent = `https://${c.authServer}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${c.integrationKey}&redirect_uri=${encodeURIComponent(config.appUrl)}`;
    throw Object.assign(new Error(j.error === "consent_required" ? `DocuSign needs one-time consent. Open: ${consent}` : `DocuSign auth failed: ${j.error_description || j.error || r.status}`), { status: 502 });
  }
  const ui = await (await fetch(`https://${c.authServer}/oauth/userinfo`, { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
  const acct = (ui.accounts || []).find((a) => a.account_id === c.accountId) || (ui.accounts || []).find((a) => a.is_default);
  cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000, baseUri: acct?.base_uri, accountId: acct?.account_id || c.accountId, key: c.integrationKey };
  return cache;
}

/**
 * Create and send an envelope.
 * opts: { dealId, unit, subject, message, templateId?, roleName?, pdfBase64?, fileName?, signer: {name, email} }
 */
async function sendEnvelope(org, opts) {
  const c = await dsConfig(org.id);
  if (!isConfigured(c)) throw Object.assign(new Error("DocuSign isn't connected. Add the integration key, user ID, account ID and RSA private key under Integrations → DocuSign."), { status: 503 });
  const t = await token(c);
  const signer = { email: opts.signer.email, name: opts.signer.name || opts.signer.email, recipientId: "1", routingOrder: "1" };
  const body = {
    emailSubject: opts.subject || "Please sign", emailBlurb: opts.message || "", status: "sent",
    eventNotification: {
      url: `${config.publicApiUrl}/webhooks/docusign/${org.public_id}`, requireAcknowledgment: "true", loggingEnabled: "true", deliveryMode: "SIM",
      events: ["envelope-sent", "envelope-delivered", "envelope-completed", "envelope-declined", "envelope-voided"],
      eventData: { version: "restv2.1", format: "json", includeData: [] }, includeHMAC: config.docusign.connectHmacKey ? "true" : "false",
    },
  };
  const templateId = opts.templateId || c.defaultTemplateId;
  if (opts.pdfBase64) {
    body.documents = [{ documentBase64: opts.pdfBase64, name: opts.fileName || "Agreement.pdf", fileExtension: "pdf", documentId: "1" }];
    body.recipients = { signers: [{ ...signer, tabs: { signHereTabs: [{ anchorString: "/sn1/", anchorUnits: "pixels", anchorXOffset: "0", anchorYOffset: "0", anchorIgnoreIfNotPresent: "true" }, { documentId: "1", pageNumber: "1", xPosition: "400", yPosition: "700" }], dateSignedTabs: [{ anchorString: "/ds1/", anchorIgnoreIfNotPresent: "true" }] } }] };
  } else if (templateId) {
    body.templateId = templateId;
    body.templateRoles = [{ email: signer.email, name: signer.name, roleName: opts.roleName || "Signer" }];
  } else throw Object.assign(new Error("Attach a PDF or set a DocuSign template ID."), { status: 400 });

  const r = await fetch(`${t.baseUri}/restapi/v2.1/accounts/${t.accountId}/envelopes`, { method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`DocuSign: ${j.message || j.errorCode || r.status}`), { status: 502 });
  await db("envelopes").insert({ envelope_id: j.envelopeId, org_id: org.id, unit: opts.unit, deal_id: opts.dealId || null, contact_id: opts.contactId || null, status: j.status || "sent", subject: body.emailSubject });
  await addActivity(org.id, opts.unit, { kind: "note", title: `Sent for signature: ${body.emailSubject}`, body: `DocuSign envelope to ${signer.name} <${signer.email}>`, refs: { deal: opts.dealId ? [opts.dealId] : [], contact: opts.contactId ? [opts.contactId] : [] } });
  return { envelopeId: j.envelopeId, status: j.status };
}

function verifyConnect(rawBody, headers) {
  const key = config.docusign.connectHmacKey;
  if (!key) return true;
  const expected = crypto.createHmac("sha256", key).update(rawBody).digest("base64");
  return Object.keys(headers).filter((h) => /^x-docusign-signature-\d+$/i.test(h)).some((h) => headers[h] === expected);
}

async function handleConnect(orgPublicId, payload) {
  const org = await db("orgs").where({ public_id: orgPublicId }).first();
  if (!org) return;
  const envId = payload?.data?.envelopeId || payload?.envelopeId;
  const status = (payload?.event || "").replace("envelope-", "") || payload?.data?.envelopeSummary?.status;
  const env = envId && (await db("envelopes").where({ envelope_id: envId, org_id: org.id }).first());
  if (!env || !status || env.status === status) return;
  await db("envelopes").where({ envelope_id: envId }).update({ status, updated_at: db.fn.now() });
  const label = { delivered: "opened", completed: "signed by all parties", declined: "declined", voided: "voided", sent: "sent" }[status] || status;
  await addActivity(org.id, env.unit, { kind: "note", title: `DocuSign: “${env.subject}” ${label}`, refs: { deal: env.deal_id ? [env.deal_id] : [], contact: env.contact_id ? [env.contact_id] : [] } });
  if (status === "completed") {
    const deal = env.deal_id && (await getRecord(org.id, "deals", env.deal_id));
    emit(org.id, "envelope.completed", { unit: env.unit, envelopeId: envId, deal });
  }
}

module.exports = { sendEnvelope, handleConnect, verifyConnect, dsConfig, isConfigured };
