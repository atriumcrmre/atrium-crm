require("dotenv").config();

module.exports = {
  client: "pg",
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 10 },
  migrations: { directory: __dirname + "/migrations", tableName: "knex_migrations" },
};
