// Starts a local PostgreSQL for development without Docker: node scripts/dev-db.js
const path = require("path");
const EmbeddedPostgres = require("embedded-postgres").default;
const port = Number(process.env.PGPORT || 5433);
const pg = new EmbeddedPostgres({ databaseDir: path.join(__dirname, "..", ".pgdata"), user: "atrium", password: "atrium", port, persistent: true });
(async () => {
  const fs = require("fs");
  if (!fs.existsSync(path.join(__dirname, "..", ".pgdata", "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase("atrium"); } catch (_) {}
  console.log(`PostgreSQL ready: DATABASE_URL=postgres://atrium:atrium@localhost:${port}/atrium`);
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})().catch((e) => { console.error(e); process.exit(1); });
