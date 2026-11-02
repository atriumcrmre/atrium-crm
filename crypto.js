const crypto = require("crypto");
const { config } = require("../config");

const key = () => Buffer.from(config.encryptionKey, "base64");

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
function encrypt(plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function decrypt(payload) {
  if (!payload) return null;
  const buf = Buffer.from(payload, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const encryptJson = (obj) => encrypt(JSON.stringify(obj || {}));
const decryptJson = (s) => { try { return JSON.parse(decrypt(s) || "{}"); } catch { return {}; } };

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");
const shortId = () => crypto.randomBytes(6).toString("hex").replace(/^\d/, "x"); // alnum, starts with a letter
const hmacHex = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const safeEqual = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

module.exports = { encrypt, decrypt, encryptJson, decryptJson, sha256, sha1, randomToken, shortId, hmacHex, safeEqual };
