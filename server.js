const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const { config, assertConfig } = require("./config");

assertConfig();
const db = require("./db");
const worker = require("./services/worker");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(cookieParser());

// Public + provider webhooks need raw bodies or open CORS, so they mount before the JSON parser.
app.use(require("./routes/public"));

app.use(express.json({ limit: "2mb" }));
app.get("/health", async (req, res) => {
  try { await db.raw("select 1"); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.use("/v1", require("./routes/api-v1"));
app.use("/api", require("./routes/auth"));
app.use("/api", require("./routes/workspace"));
app.use("/api", require("./routes/marketing"));
app.use("/api", require("./routes/integrations"));
app.use("/api", require("./routes/ai"));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"], index: "login.html" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: config.env === "production" ? "Something went wrong." : err.message });
});

const server = app.listen(config.port, () => {
  console.log(`Atrium CRM running at ${config.appUrl} (port ${config.port})`);
  if (process.env.DISABLE_WORKER !== "true") worker.start();
});

const shutdown = () => { server.close(() => db.destroy().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = app;
