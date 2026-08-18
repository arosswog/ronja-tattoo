const { Pool } = require("pg");

let pool = null;

// Lazy singleton: created on first use, not at module load. This lets
// scripts (like the migration runner) import this module before
// process.env is fully populated, and avoids opening a connection during
// `require()` in contexts that never actually query the database.
function getPool() {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Keine Datenbankverbindung konfiguriert. POSTGRES_URL (oder DATABASE_URL) muss gesetzt sein."
    );
  }

  // max: 1 keeps each serverless function instance to a single connection,
  // which is the documented-safe pattern against Neon's pooled endpoint
  // (avoids connection exhaustion when many Lambda instances spin up
  // concurrently). sslmode is already encoded in the connection string.
  pool = new Pool({ connectionString, max: 1 });
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Runs `run(client)` inside a BEGIN/COMMIT block, rolling back on error.
// Use this (not plain `query`) whenever more than one statement must be
// atomic — e.g. row-locking a slot before inserting a booking.
async function withTransaction(run) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withTransaction, closePool };
