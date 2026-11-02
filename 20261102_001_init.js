/**
 * Atrium schema.
 *
 * CRM objects (contacts, companies, deals, tickets, ...) live in `records`: one row per
 * object, keyed by (org_id, type, id), with the full object in a JSONB `data` column and
 * the fields the server queries on (email, unit) promoted to indexed columns. This keeps
 * custom properties flexible while the server can still look contacts up by email.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("orgs", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.string("name").notNullable();
    t.string("public_id", 32).notNullable().unique(); // used in public URLs (forms, webhooks)
    t.jsonb("settings").notNullable().defaultTo("{}");
    t.timestamps(true, true);
  });

  await knex.schema.createTable("users", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("email").notNullable().unique();
    t.string("name").notNullable();
    t.string("password_hash");
    t.string("role").notNullable().defaultTo("member"); // owner | admin | member
    t.string("default_unit", 3).notNullable().defaultTo("res");
    t.timestamp("last_login_at");
    t.timestamps(true, true);
    t.index(["org_id"]);
  });

  await knex.schema.createTable("invites", (t) => {
    t.string("token", 64).primary();
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("email").notNullable();
    t.string("role").notNullable().defaultTo("member");
    t.uuid("invited_by").references("users.id").onDelete("SET NULL");
    t.timestamp("expires_at").notNullable();
    t.timestamp("accepted_at");
    t.timestamps(true, true);
  });

  await knex.schema.createTable("oauth_accounts", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("user_id").notNullable().references("users.id").onDelete("CASCADE");
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("provider", 16).notNullable(); // google | microsoft
    t.string("provider_user_id").notNullable();
    t.string("email").notNullable();
    t.text("access_token_enc");
    t.text("refresh_token_enc");
    t.timestamp("expires_at");
    t.text("scopes");
    t.boolean("mail_enabled").notNullable().defaultTo(false);
    t.boolean("cal_enabled").notNullable().defaultTo(false);
    t.jsonb("mail_state").notNullable().defaultTo("{}");
    t.jsonb("cal_state").notNullable().defaultTo("{}");
    t.timestamp("last_mail_sync_at");
    t.timestamp("last_cal_sync_at");
    t.text("last_error");
    t.timestamps(true, true);
    t.unique(["provider", "provider_user_id", "user_id"]);
  });

  await knex.schema.createTable("records", (t) => {
    t.string("id", 64).notNullable();
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("unit", 3).notNullable(); // res | com
    t.string("type", 24).notNullable(); // contacts | companies | deals | tickets | ...
    t.jsonb("data").notNullable();
    t.string("email"); // contacts only, lowercased, for matching mail and form submissions
    t.string("ext_key"); // provider id for synced mail/events, for de-duplication
    t.boolean("deleted").notNullable().defaultTo(false);
    t.bigInteger("updated_ms").notNullable();
    t.string("updated_by", 64); // client id or "server"
    t.primary(["org_id", "type", "id"]);
    t.index(["org_id", "updated_ms"]);
    t.index(["org_id", "type", "email"]);
    t.index(["org_id", "type", "ext_key"]);
  });

  await knex.schema.createTable("integrations", (t) => {
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("provider", 32).notNullable(); // zillow | bridge | costar | docusign | netlify
    t.boolean("enabled").notNullable().defaultTo(true);
    t.text("config_enc"); // encrypted JSON (tokens, ids)
    t.jsonb("meta").notNullable().defaultTo("{}"); // non-secret display data
    t.timestamps(true, true);
    t.primary(["org_id", "provider"]);
  });

  await knex.schema.createTable("api_keys", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("name").notNullable();
    t.string("prefix", 16).notNullable();
    t.string("key_hash", 128).notNullable().unique();
    t.timestamp("last_used_at");
    t.timestamp("revoked_at");
    t.timestamps(true, true);
  });

  await knex.schema.createTable("webhooks", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.text("url").notNullable();
    t.string("event", 64).notNullable();
    t.string("secret", 64).notNullable();
    t.timestamp("last_delivery_at");
    t.integer("last_status");
    t.timestamps(true, true);
  });

  await knex.schema.createTable("marketing_sends", (t) => {
    t.bigIncrements("id");
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("unit", 3).notNullable();
    t.string("email_id", 64).notNullable();
    t.string("contact_id", 64);
    t.string("to_email").notNullable();
    t.string("status", 24).notNullable().defaultTo("queued");
    t.timestamp("delivered_at");
    t.timestamp("opened_at");
    t.timestamp("clicked_at");
    t.timestamp("bounced_at");
    t.timestamps(true, true);
    t.index(["org_id", "email_id"]);
    t.unique(["org_id", "email_id", "to_email"]);
  });

  await knex.schema.createTable("suppressions", (t) => {
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("email").notNullable();
    t.string("reason", 32).notNullable();
    t.timestamps(true, true);
    t.primary(["org_id", "email"]);
  });

  await knex.schema.createTable("envelopes", (t) => {
    t.string("envelope_id", 64).primary();
    t.uuid("org_id").notNullable().references("orgs.id").onDelete("CASCADE");
    t.string("unit", 3).notNullable();
    t.string("deal_id", 64);
    t.string("contact_id", 64);
    t.string("status", 32).notNullable();
    t.text("subject");
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  for (const t of ["envelopes", "suppressions", "marketing_sends", "webhooks", "api_keys", "integrations", "records", "oauth_accounts", "invites", "users", "orgs"]) {
    await knex.schema.dropTableIfExists(t);
  }
};
