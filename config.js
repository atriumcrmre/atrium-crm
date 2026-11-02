require("dotenv").config();

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const required = ["DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY"];

const config = {
  env: env("NODE_ENV", "development"),
  port: Number(env("PORT", 4000)),
  appUrl: env("APP_URL", "http://localhost:4000").replace(/\/$/, ""),
  publicApiUrl: env("PUBLIC_API_URL", env("APP_URL", "http://localhost:4000")).replace(/\/$/, ""),
  databaseUrl: env("DATABASE_URL"),
  sessionSecret: env("SESSION_SECRET"),
  encryptionKey: env("ENCRYPTION_KEY"),
  allowSignup: env("ALLOW_SIGNUP", "true") === "true",

  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  },
  microsoft: {
    clientId: env("MICROSOFT_CLIENT_ID"),
    clientSecret: env("MICROSOFT_CLIENT_SECRET"),
    tenant: env("MICROSOFT_TENANT", "common"),
  },
  sendgrid: {
    apiKey: env("SENDGRID_API_KEY"),
    fromEmail: env("SENDGRID_FROM_EMAIL"),
    fromName: env("SENDGRID_FROM_NAME", "Atrium Realty"),
    webhookPublicKey: env("SENDGRID_WEBHOOK_PUBLIC_KEY"),
  },
  netlify: { token: env("NETLIFY_AUTH_TOKEN"), siteId: env("NETLIFY_SITE_ID") },
  docusign: {
    integrationKey: env("DOCUSIGN_INTEGRATION_KEY"),
    userId: env("DOCUSIGN_USER_ID"),
    accountId: env("DOCUSIGN_ACCOUNT_ID"),
    privateKey: env("DOCUSIGN_PRIVATE_KEY", "").replace(/\\n/g, "\n"),
    authServer: env("DOCUSIGN_AUTH_SERVER", "account-d.docusign.com"),
    connectHmacKey: env("DOCUSIGN_CONNECT_HMAC_KEY"),
  },
  bridge: { serverToken: env("BRIDGE_SERVER_TOKEN"), dataset: env("BRIDGE_DATASET") },
  ai: { provider: env("AI_PROVIDER", "") },
  gemini: { apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL", "gemini-2.5-flash") },
  anthropic: { apiKey: env("ANTHROPIC_API_KEY"), model: env("ANTHROPIC_MODEL", "claude-sonnet-5-5") },
  company: { address: env("COMPANY_POSTAL_ADDRESS", "Add your postal address in COMPANY_POSTAL_ADDRESS") },
};

function assertConfig() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in (npm run gen:keys creates the secrets).`);
    process.exit(1);
  }
  if (Buffer.from(config.encryptionKey, "base64").length !== 32) {
    console.error("ENCRYPTION_KEY must be 32 bytes, base64-encoded. Run: npm run gen:keys");
    process.exit(1);
  }
}

module.exports = { config, assertConfig };
