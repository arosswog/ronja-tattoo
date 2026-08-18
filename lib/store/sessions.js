const crypto = require("crypto");

const { query } = require("../db");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Returns the raw token (only ever held by the caller/cookie) after storing
// its hash. The DB never sees the raw token, so a leaked row (backup, log,
// query tool) can't be replayed as a live session.
async function createSession(ttlMs) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);

  await query(
    "INSERT INTO sessions (token_hash, expires_at) VALUES ($1, $2)",
    [hashToken(token), expiresAt]
  );

  return token;
}

async function getSession(token) {
  if (!token) {
    return null;
  }

  const { rows } = await query(
    "SELECT token_hash, created_at, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()",
    [hashToken(token)]
  );

  return rows[0] || null;
}

async function deleteSession(token) {
  if (!token) {
    return;
  }

  await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

async function clearExpiredSessions() {
  await query("DELETE FROM sessions WHERE expires_at <= now()");
}

module.exports = { createSession, getSession, deleteSession, clearExpiredSessions };
