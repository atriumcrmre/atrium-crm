// Prints fresh secrets for .env
const c = require("crypto");
console.log(`SESSION_SECRET=${c.randomBytes(48).toString("base64url")}`);
console.log(`ENCRYPTION_KEY=${c.randomBytes(32).toString("base64")}`);
