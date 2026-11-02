/**
 * CoStar import.
 *
 * CoStar does not offer a public self-serve API; subscribers export tenant, property and
 * lease-comp reports as CSV/Excel (and enterprise customers can arrange data feeds). This
 * imports those exports: tenant reports become companies (with lease expirations and SF)
 * plus contacts when contact columns exist; property reports become commercial listings.
 * Rows are matched on name/address so re-importing updates instead of duplicating.
 */
const { parse } = require("csv-parse/sync");
const { listRecords, putRecord, upsertContact, newId } = require("../lib/records");

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v) => { const n = Number(String(v ?? "").replace(/[$,%\s]|sf|\/yr/gi, "")); return Number.isFinite(n) ? n : 0; };
const date = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function col(headers, ...names) {
  const H = headers.map(norm);
  for (const n of names) { const i = H.indexOf(norm(n)); if (i >= 0) return headers[i]; }
  for (const n of names) { const i = H.findIndex((h) => h.includes(norm(n))); if (i >= 0) return headers[i]; }
  return null;
}

function detect(headers) {
  if (col(headers, "Tenant Name", "Tenant", "Company Name") && col(headers, "Lease Expiration", "Expiration Date", "Lease Exp", "SF Occupied", "Square Feet Occupied")) return "tenants";
  if (col(headers, "Property Address", "Building Address", "Address") && col(headers, "RBA", "Rentable Building Area", "Building SF", "Property Type", "Cap Rate")) return "properties";
  if (col(headers, "Tenant Name", "Tenant", "Company Name")) return "tenants";
  return null;
}

async function importCostar(org, csvText, owner) {
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true });
  if (!rows.length) throw Object.assign(new Error("The file has no data rows."), { status: 400 });
  const headers = Object.keys(rows[0]);
  const kind = detect(headers);
  if (!kind) throw Object.assign(new Error("Couldn't recognize this export. Use a CoStar tenant report (Tenant Name, SF Occupied, Lease Expiration) or a property report (Property Address, RBA, Property Type)."), { status: 400 });
  const out = { kind, created: 0, updated: 0, contacts: 0 };

  if (kind === "tenants") {
    const C = {
      name: col(headers, "Tenant Name", "Tenant", "Company Name"), sf: col(headers, "SF Occupied", "Square Feet Occupied", "SF Leased", "Square Feet"),
      exp: col(headers, "Lease Expiration", "Expiration Date", "Lease Exp"), ind: col(headers, "Industry", "Tenant Industry", "NAICS Description", "SIC Description"),
      city: col(headers, "City", "Property City"), addr: col(headers, "Property Address", "Building Address", "Address"), emp: col(headers, "Employees", "Number of Employees"),
      web: col(headers, "Website", "Web Site", "Domain"), phone: col(headers, "Phone", "Tenant Phone"),
      cname: col(headers, "Contact Name", "Primary Contact", "Contact"), cemail: col(headers, "Contact Email", "Email"), ctitle: col(headers, "Contact Title", "Title"),
    };
    const existing = await listRecords(org.id, { unit: "com", type: "companies" });
    for (const r of rows) {
      const name = r[C.name]; if (!name) continue;
      const prev = existing.find((c) => norm(c.name) === norm(name));
      const rec = {
        ...(prev || {}), id: prev?.id || newId(), name, domain: (C.web && r[C.web]) || prev?.domain || "—", industry: (C.ind && r[C.ind]) || prev?.industry || "Other",
        city: (C.city && r[C.city]) || prev?.city || "", employees: num(C.emp && r[C.emp]) || prev?.employees || 0, owner: prev?.owner || owner, lifecycle: prev?.lifecycle || "Lead",
        phone: (C.phone && r[C.phone]) || prev?.phone || "", created: prev?.created || Date.now(), expiry: date(C.exp && r[C.exp]) ?? prev?.expiry ?? null, sf: num(C.sf && r[C.sf]) || prev?.sf || 0,
        address: (C.addr && r[C.addr]) || prev?.address || "", source: "CoStar",
      };
      delete rec._unit; delete rec._type;
      await putRecord(org.id, "com", "companies", rec);
      prev ? out.updated++ : out.created++;
      if (!prev) existing.push(rec);
      if (C.cemail && r[C.cemail]) {
        await upsertContact(org.id, "com", { name: C.cname ? r[C.cname] : "", email: r[C.cemail], title: C.ctitle ? r[C.ctitle] : "", company: rec.id, type: "Tenant", area: `${rec.industry} · ${rec.sf ? rec.sf.toLocaleString("en-US") + " SF" : ""}` }, { owner, source: "CoStar" });
        out.contacts++;
      }
    }
  } else {
    const C = {
      addr: col(headers, "Property Address", "Building Address", "Address"), name: col(headers, "Property Name", "Building Name"), city: col(headers, "City", "Submarket Name", "Submarket"),
      type: col(headers, "Property Type", "PropertyType"), cls: col(headers, "Building Class", "Class"), sf: col(headers, "RBA", "Rentable Building Area", "Building SF", "Total Available Space (SF)"),
      rate: col(headers, "Rent/SF/Yr", "Average Weighted Rent", "Asking Rent", "Rent Per SF"), cap: col(headers, "Cap Rate"), price: col(headers, "For Sale Price", "Sale Price", "Price"),
      occ: col(headers, "Percent Leased", "% Leased", "Occupancy"), noi: col(headers, "NOI", "Net Operating Income"), status: col(headers, "Status", "For Sale Status"),
    };
    const existing = await listRecords(org.id, { unit: "com", type: "properties" });
    for (const r of rows) {
      const name = (C.name && r[C.name]) || r[C.addr]; if (!name) continue;
      const prev = existing.find((p) => norm(p.name) === norm(name) || (p.address && norm(p.address) === norm(r[C.addr])));
      const price = num(C.price && r[C.price]);
      const rec = {
        ...(prev || {}), id: prev?.id || newId(), name, address: r[C.addr] || "", area: (C.city && r[C.city]) || "", kind: (C.type && r[C.type]) || "Office",
        cls: (C.cls && r[C.cls]) || "—", sf: num(C.sf && r[C.sf]), rate: num(C.rate && r[C.rate]) || null, cap: num(C.cap && r[C.cap]) || null, noi: num(C.noi && r[C.noi]) || null,
        occ: num(C.occ && r[C.occ]), price: price || null, status: (C.status && r[C.status]) || (price ? "For sale" : "For lease"), source: "CoStar",
      };
      delete rec._unit; delete rec._type;
      await putRecord(org.id, "com", "properties", rec);
      prev ? out.updated++ : out.created++;
      if (!prev) existing.push(rec);
    }
  }
  return out;
}

module.exports = { importCostar, detect };
