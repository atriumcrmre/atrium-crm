/**
 * Zillow Premier Agent leads.
 *
 * Zillow delivers leads to approved partners by HTTP POST to a URL you register with
 * Zillow (lead routing / Tech Connect). Field names differ between programs, so this
 * maps the common shapes. Each lead becomes (or updates) a contact, an activity, a
 * follow-up task and a deal in the Buyer pipeline.
 */
const { upsertContact, addActivity, putRecord, newId, listRecords } = require("../lib/records");
const { emit } = require("../lib/webhooks");

const pick = (o, ...keys) => { for (const k of keys) { const v = k.split(".").reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== "") return v; } return ""; };

function normalize(body) {
  const b = body?.lead || body?.Lead || body || {};
  const first = pick(b, "contact.firstName", "firstName", "first_name", "FirstName");
  const last = pick(b, "contact.lastName", "lastName", "last_name", "LastName");
  const name = pick(b, "contact.name", "name", "contactName", "fullName") || `${first} ${last}`.trim();
  return {
    first: first || String(name).split(/\s+/)[0], last: last || String(name).split(/\s+/).slice(1).join(" "),
    email: String(pick(b, "contact.email", "email", "emailAddress", "Email")).trim().toLowerCase(),
    phone: pick(b, "contact.phone", "phone", "phoneNumber", "Phone"),
    message: pick(b, "message", "comments", "inquiry", "Message"),
    address: pick(b, "listing.address", "property.address", "propertyAddress", "address", "listingAddress", "street"),
    city: pick(b, "listing.city", "property.city", "city"),
    price: Number(pick(b, "listing.price", "property.price", "listPrice", "price")) || 0,
    zpid: pick(b, "listing.zpid", "property.zpid", "zpid"),
    leadType: pick(b, "leadType", "type", "inquiryType") || "Buyer",
    id: pick(b, "leadId", "id", "lead_id"),
  };
}

async function ingestLead(org, body, owner) {
  const L = normalize(body);
  if (!L.email && !L.phone) throw Object.assign(new Error("Lead has no email or phone"), { status: 422 });
  const isSeller = /sell/i.test(L.leadType);
  const { contact, unit, created } = await upsertContact(org.id, "res", { first: L.first, last: L.last, email: L.email, phone: L.phone, type: isSeller ? "Seller" : "Buyer", budget: L.price, area: L.city }, { owner, source: "Zillow", lifecycle: "Lead" });
  const listing = [L.address, L.city].filter(Boolean).join(", ");
  await addActivity(org.id, unit, { kind: "form", title: `Zillow lead${listing ? ": " + listing : ""}`, body: [L.message, L.zpid ? `zpid ${L.zpid}` : ""].filter(Boolean).join("\n"), refs: { contact: [contact.id] } });
  const task = { id: newId(), title: `Call Zillow lead ${contact.first} ${contact.last}`.trim(), due: Date.now(), kind: "Call", ref: { contact: contact.id }, done: false, owner: owner || contact.owner };
  await putRecord(org.id, unit, "tasks", task);

  const deals = await listRecords(org.id, { unit, type: "deals" });
  let deal = deals.find((d) => (d.contacts || []).includes(contact.id) && !["won", "lost"].includes(d.stage));
  if (!deal) {
    deal = { id: newId(), name: `${contact.last || contact.first} – ${listing || "Zillow inquiry"}`, pipe: isSeller ? "list" : "buy", stage: isSeller ? "lappt" : "appt", amount: L.price, close: Date.now() + 45 * 864e5, owner: owner || contact.owner, contacts: [contact.id], company: null, prop: null, created: Date.now(), priority: "High", dtype: "New business" };
    await putRecord(org.id, unit, "deals", deal);
    emit(org.id, "deal.created", { unit, deal });
  }
  emit(org.id, "form.submitted", { unit, source: "zillow", contact });
  return { contactId: contact.id, created, dealId: deal.id };
}

module.exports = { ingestLead, normalize };
