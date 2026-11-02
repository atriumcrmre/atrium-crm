/**
 * Keystone AI providers. The web app speaks one format (Anthropic-style messages with
 * text / tool_use / tool_result blocks); this module sends it to the configured provider
 * and converts the reply back, so switching providers needs no front-end changes.
 *
 *   AI_PROVIDER=gemini     (GEMINI_API_KEY, GEMINI_MODEL)        - Google Gemini API, has a free tier
 *   AI_PROVIDER=anthropic  (ANTHROPIC_API_KEY, ANTHROPIC_MODEL)  - Claude
 */
const crypto = require("crypto");
const { config } = require("../config");

function provider() {
  const p = config.ai.provider;
  if (p === "gemini" || p === "anthropic") return p;
  return config.gemini.apiKey ? "gemini" : config.anthropic.apiKey ? "anthropic" : null;
}
const isConfigured = () => {
  const p = provider();
  return p === "gemini" ? !!config.gemini.apiKey : p === "anthropic" ? !!config.anthropic.apiKey : false;
};
const label = () => ({ gemini: "Google Gemini", anthropic: "Claude" }[provider()] || null);

class AiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

/* ---------------- Anthropic ---------------- */
async function anthropic({ system, messages, tools, maxTokens, userId }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.anthropic.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: config.anthropic.model, max_tokens: maxTokens, messages, ...(system ? { system } : {}), ...(tools?.length ? { tools } : {}), metadata: { user_id: userId } }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AiError(j.error?.message || `Claude API error ${r.status}`, r.status === 429 ? 429 : 502);
  return { content: j.content, stop_reason: j.stop_reason, usage: j.usage };
}

/* ---------------- Gemini ---------------- */
/**
 * Gemini accepts an OpenAPI-style subset of JSON Schema, and objects must declare their
 * properties. Free-form object parameters (like `fields`) are sent as JSON strings and
 * parsed back into objects when the model calls the tool.
 */
function toGeminiSchema(schema, path, jsonPaths) {
  if (!schema || typeof schema !== "object") return { type: "STRING" };
  const out = {};
  if (schema.description) out.description = String(schema.description);
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === "object") {
    const props = schema.properties || {};
    if (!Object.keys(props).length) {
      jsonPaths.add(path);
      return { type: "STRING", description: `${out.description ? out.description + ". " : ""}A JSON object, written as a JSON string.` };
    }
    out.type = "OBJECT";
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v, path ? `${path}.${k}` : k, jsonPaths)]));
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required.filter((k) => k in props);
    return out;
  }
  if (t === "array") { out.type = "ARRAY"; out.items = toGeminiSchema(schema.items || { type: "string" }, `${path}[]`, new Set()); return out; }
  out.type = { number: "NUMBER", integer: "INTEGER", boolean: "BOOLEAN" }[t] || "STRING";
  if (Array.isArray(schema.enum) && out.type === "STRING") out.enum = schema.enum.map(String);
  return out;
}

function parseJsonArgs(args, jsonPaths) {
  for (const p of jsonPaths) {
    if (p.includes("[]") || p.includes(".")) continue; // only top-level free-form objects are used by Keystone's tools
    if (typeof args[p] === "string") { try { args[p] = JSON.parse(args[p]); } catch { args[p] = {}; } }
  }
  return args;
}

function toGeminiContents(messages) {
  const names = {}; // tool_use id -> tool name, for functionResponse parts
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) parts.push({ text: b.text, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
      else if (b.type === "tool_use") {
        names[b.id] = b.name;
        parts.push({ functionCall: { name: b.name, args: b.input || {}, ...(b._gid ? { id: b._gid } : {}) }, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
      } else if (b.type === "tool_result") {
        let response; try { response = JSON.parse(typeof b.content === "string" ? b.content : JSON.stringify(b.content)); } catch { response = { result: String(b.content) }; }
        if (response === null || typeof response !== "object" || Array.isArray(response)) response = { result: response };
        parts.push({ functionResponse: { name: names[b.tool_use_id] || "tool", response, ...(b._gid ? { id: b._gid } : {}) } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

async function gemini({ system, messages, tools, maxTokens }) {
  const jsonPaths = {};
  const declarations = (tools || []).map((t) => {
    jsonPaths[t.name] = new Set();
    const params = toGeminiSchema(t.input_schema || { type: "object", properties: {} }, "", jsonPaths[t.name]);
    return { name: t.name, description: t.description, ...(params.type === "OBJECT" ? { parameters: params } : {}) };
  });
  const body = {
    contents: toGeminiContents(messages),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    // Thinking models count reasoning toward output tokens, so leave generous headroom.
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 8192) },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
  const r = await fetch(url, { method: "POST", headers: { "x-goog-api-key": config.gemini.apiKey, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `Gemini API error ${r.status}`;
    if (r.status === 429) throw new AiError("Gemini's free-tier limit was reached. Try again in a minute, or later today if the daily limit is used up.", 429);
    throw new AiError(msg, 502);
  }
  const cand = j.candidates?.[0];
  if (!cand) throw new AiError(j.promptFeedback?.blockReason ? `Gemini declined this request (${j.promptFeedback.blockReason}).` : "Gemini returned no answer.", 502);
  const content = [];
  for (const p of cand.content?.parts || []) {
    if (p.thought) continue; // thought summaries are not shown to the user
    if (p.functionCall) {
      const args = parseJsonArgs({ ...(p.functionCall.args || {}) }, jsonPaths[p.functionCall.name] || new Set());
      content.push({ type: "tool_use", id: "toolu_" + crypto.randomBytes(9).toString("hex"), name: p.functionCall.name, input: args, ...(p.functionCall.id ? { _gid: p.functionCall.id } : {}), ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}) });
    } else if (typeof p.text === "string") {
      content.push({ type: "text", text: p.text, ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}) });
    }
  }
  const hasTools = content.some((b) => b.type === "tool_use");
  return {
    content,
    stop_reason: hasTools ? "tool_use" : cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    usage: j.usageMetadata ? { input_tokens: j.usageMetadata.promptTokenCount, output_tokens: j.usageMetadata.candidatesTokenCount } : undefined,
  };
}

/** One model turn. messages/tools use the Anthropic-style shape. */
async function complete({ system, messages, tools, maxTokens = 1500, userId }) {
  const p = provider();
  if (!isConfigured()) throw new AiError("Keystone AI isn't configured. Set GEMINI_API_KEY (free tier available) or ANTHROPIC_API_KEY on the server.", 503);
  // Gemini needs functionResponse ids to match functionCall ids: copy _gid from tool_use onto its tool_result.
  if (p === "gemini") {
    const gids = {};
    for (const m of messages) for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === "tool_use" && b._gid) gids[b.id] = b._gid;
      if (b.type === "tool_result" && gids[b.tool_use_id]) b._gid = gids[b.tool_use_id];
    }
    return gemini({ system, messages, tools, maxTokens });
  }
  // Claude rejects unknown fields, so strip Gemini metadata from any earlier turns.
  const clean = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map(({ _sig, _gid, ...b }) => b) } : m));
  return anthropic({ system, messages: clean, tools, maxTokens, userId });
}

module.exports = { complete, provider, isConfigured, label, toGeminiSchema, toGeminiContents, AiError };
