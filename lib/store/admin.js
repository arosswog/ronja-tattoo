const { query } = require("../db");

async function getAdminSettings() {
  const { rows } = await query(
    "SELECT configured, password_hash, salt, created_at FROM admin_account WHERE id = 1"
  );
  const row = rows[0] || {};
  return {
    configured: Boolean(row.configured),
    passwordHash: row.password_hash || "",
    salt: row.salt || "",
    createdAt: row.created_at || null,
  };
}

async function setAdminCredentials({ passwordHash, salt }) {
  await query(
    `UPDATE admin_account
     SET configured = true, password_hash = $1, salt = $2, created_at = now()
     WHERE id = 1`,
    [passwordHash, salt]
  );
}

async function resetAdminAccount() {
  await query(
    `UPDATE admin_account
     SET configured = false, password_hash = '', salt = '', created_at = NULL
     WHERE id = 1`
  );
}

module.exports = { getAdminSettings, setAdminCredentials, resetAdminAccount };
