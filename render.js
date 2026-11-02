/** HTML rendering for marketing emails and Netlify landing pages. */
const { config } = require("../config");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const personalize = (s, vars) => String(s || "").replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const absUrl = (u, base) => (!u ? base || "#" : /^https?:\/\//.test(u) ? u : (base || config.appUrl).replace(/\/$/, "") + (u.startsWith("/") ? u : "/" + u));

/** Renders an email from the app's block model. {first_name} and friends are filled per recipient. */
function renderEmail(email, vars, { unsubscribeUrl, accent = "#0e8c6a", siteBase } = {}) {
  const P = (s) => esc(personalize(s, vars));
  const blocks = (email.blocks || []).map((b) => {
    switch (b.type) {
      case "heading": return `<tr><td style="padding:0 0 14px"><h1 style="margin:0;font:700 24px/1.25 Georgia,serif;color:#1c2628">${P(b.text)}</h1></td></tr>`;
      case "text": return `<tr><td style="padding:0 0 14px;font:15px/1.6 Georgia,serif;color:#1c2628">${P(b.text).replace(/\n/g, "<br>")}</td></tr>`;
      case "button": return `<tr><td style="padding:4px 0 18px"><a href="${esc(absUrl(b.url, siteBase))}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${accent};color:#ffffff;font:700 14px Arial,sans-serif;text-decoration:none">${esc(b.text)}</a></td></tr>`;
      case "listing": return `<tr><td style="padding:0 0 16px"><table width="100%" style="border:1px solid #e4ebec;border-radius:10px"><tr><td style="padding:14px;font:600 14px Arial,sans-serif;color:#1c2628">${P(b.text)}</td></tr></table></td></tr>`;
      case "image": return `<tr><td style="padding:0 0 16px"><div style="height:150px;border-radius:8px;background:#dfe9e8"></div></td></tr>`;
      case "divider": return `<tr><td style="padding:6px 0 18px"><hr style="border:0;border-top:1px solid #e4ebec"></td></tr>`;
      default: return "";
    }
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${P(email.subject)}</title></head>
<body style="margin:0;background:#eef3f3"><span style="display:none;max-height:0;overflow:hidden">${P(email.preheader)}</span>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f3;padding:24px 12px"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px"><tr><td style="padding:28px">
<table width="100%" cellpadding="0" cellspacing="0">${blocks}</table></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e4ebec;font:11px/1.5 Arial,sans-serif;color:#5b6b6e">${esc(vars.company_name || config.sendgrid.fromName)} · ${esc(config.company.address)}<br>You're receiving this because you're in our contacts. <a href="${esc(unsubscribeUrl || "#")}" style="color:#5b6b6e">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(email, vars, unsubscribeUrl) {
  const lines = (email.blocks || []).map((b) => (b.type === "button" ? `${b.text}: ${absUrl(b.url)}` : b.type === "divider" ? "—" : personalize(b.text, vars))).filter(Boolean);
  return `${lines.join("\n\n")}\n\n${config.company.address}\nUnsubscribe: ${unsubscribeUrl}`;
}

/** A complete, self-contained landing page. The form posts to the Atrium public API. */
function renderLandingPage(page, form, { orgPublicId, unit, brand = "Atrium Realty" }) {
  const h = Number(page.hue) || 190;
  const fields = (form?.fields || []).map((f, i) => {
    const id = `f${i}`, name = esc(f.label), req = f.required ? "required" : "";
    const label = `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>`;
    if (f.type === "checkbox") return `<label class="ck"><input type="checkbox" id="${id}" name="${name}" ${req}> ${esc(f.label)}${f.required ? " *" : ""}</label>`;
    if (f.type === "select") return `${label}<select id="${id}" name="${name}" ${req}><option value="">Choose…</option>${String(f.options || "").split(",").map((o) => o.trim()).filter(Boolean).map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    if (f.type === "textarea") return `${label}<textarea id="${id}" name="${name}" rows="3" ${req}></textarea>`;
    return `${label}<input id="${id}" name="${name}" type="${f.type === "phone" ? "tel" : esc(f.type)}" ${req}>`;
  }).join("");
  const submitUrl = `${config.publicApiUrl}/public/forms/${orgPublicId}/${encodeURIComponent(form?.id || "")}?page=${encodeURIComponent(page.id)}&unit=${unit}`;
  const viewUrl = `${config.publicApiUrl}/public/pages/${orgPublicId}/${encodeURIComponent(page.id)}/view?unit=${unit}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.headline)} | ${esc(brand)}</title><meta name="description" content="${esc(page.sub)}">
<meta property="og:title" content="${esc(page.headline)}"><meta property="og:description" content="${esc(page.sub)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Manrope:wght@400;600;700&display=swap">
<style>
:root{--h:${h};--ink:#1c2628;--muted:#5b6b6e;--line:#e4ebec;--acc:hsl(var(--h) 55% 32%)}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 Manrope,system-ui,sans-serif;color:var(--ink);background:#fff}
header{display:flex;justify-content:space-between;align-items:center;padding:16px max(20px,5vw);border-bottom:1px solid var(--line)}
header b{font:700 20px "Bricolage Grotesque",system-ui,sans-serif}
.hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:40px;padding:56px max(20px,5vw);background:linear-gradient(135deg,hsl(var(--h) 45% 95%),hsl(calc(var(--h) + 25) 40% 87%))}
h1{font:700 clamp(32px,5vw,52px)/1.05 "Bricolage Grotesque",system-ui,sans-serif;margin:0 0 16px;letter-spacing:-.02em;text-wrap:balance}
.sub{color:var(--muted);font-size:18px;margin:0 0 20px;max-width:60ch}
ul{padding-left:20px;margin:0}li{margin:6px 0}
form{background:#fff;border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 30px rgba(0,0,0,.08);align-self:start}
form h2{margin:0 0 6px;font-size:18px}label{font-size:13px;font-weight:600;color:var(--muted)}
input,select,textarea{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:9px;width:100%}
.ck{display:flex;gap:8px;align-items:center;color:var(--ink)}.ck input{width:auto}
button{margin-top:8px;padding:13px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:700 15px Manrope,sans-serif;cursor:pointer}
.hp{position:absolute;left:-9999px}.msg{font-size:14px;margin:4px 0 0}
footer{padding:24px max(20px,5vw);font-size:13px;color:var(--muted);border-top:1px solid var(--line)}
@media(max-width:760px){.hero{grid-template-columns:1fr;padding-top:36px}}
</style></head><body>
<header><b>${esc(brand)}</b><span>${unit === "com" ? "Commercial" : "Residential"}</span></header>
<section class="hero"><div><h1>${esc(page.headline)}</h1><p class="sub">${esc(page.sub)}</p><ul>${(page.bullets || []).filter(Boolean).map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>
<form id="lead" novalidate><h2>${esc(form?.name || "Get in touch")}</h2>${fields}<input class="hp" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="submit">${esc(page.cta || "Submit")}</button><p class="msg" id="msg" role="status"></p></form></section>
<footer>© ${new Date().getFullYear()} ${esc(brand)} · ${esc(config.company.address)}</footer>
<script>
fetch(${JSON.stringify(viewUrl)},{method:"POST",mode:"cors",keepalive:true}).catch(function(){});
document.getElementById("lead").addEventListener("submit",function(e){e.preventDefault();var f=e.target,m=document.getElementById("msg");
if(!f.checkValidity()){f.reportValidity();return;}var d={};new FormData(f).forEach(function(v,k){d[k]=v;});var b=f.querySelector("button");b.disabled=true;m.textContent="Sending…";
fetch(${JSON.stringify(submitUrl)},{method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Something went wrong");m.textContent="Thanks! We'll be in touch shortly.";f.reset();});}).catch(function(err){m.textContent=err.message;}).finally(function(){b.disabled=false;});});
</script></body></html>`;
}

function renderIndex(pages, brand = "Atrium Realty") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(brand)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1c2628}a{color:#0e6e55}</style></head><body><h1>${esc(brand)}</h1><ul>${pages.map((p) => `<li><a href="/${esc(p.slug)}/">${esc(p.headline)}</a></li>`).join("")}</ul></body></html>`;
}

module.exports = { esc, renderEmail, renderText, renderLandingPage, renderIndex, personalize };
