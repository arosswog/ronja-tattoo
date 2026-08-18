// Minimal, dependency-free migration runner. Applies every .sql file in
// migrations/ (in filename order) that isn't already recorded in
// schema_migrations, each inside its own transaction.
//
// Usage: node --env-file=.env.local lib/migrate.js

const fs = require("fs");
const path = require("path");

const { getPool, closePool } = require("./db");
const { seedAll } = require("./seed");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query("SELECT filename FROM schema_migrations");
  return new Set(rows.map((row) => row.filename));
}

async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      if (applied.has(filename)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      console.log(`Applying migration: ${filename}`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${filename} failed: ${error.message}`);
      }
    }

    console.log("Migrations up to date.");
  } finally {
    client.release();
  }

  await seedAll();
}

if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      return closePool();
    });
}

module.exports = { runMigrations };
