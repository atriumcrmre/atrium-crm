const knex = require("knex");
const { config } = require("./config");

const db = knex({
  client: "pg",
  connection: config.databaseUrl,
  pool: { min: 0, max: 10 },
});

module.exports = db;
