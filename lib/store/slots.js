const { query } = require("../db");

// Postgres unique_violation — thrown when a slot is created at a start time
// that already has an active (non-cancelled) slot.
const UNIQUE_VIOLATION = "23505";

function toSlot(row) {
  return {
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    label: row.label,
    depositAmountCents: row.deposit_amount_cents,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listSlots({ status } = {}) {
  const { rows } = status
    ? await query(
        "SELECT * FROM slots WHERE status = $1 ORDER BY starts_at ASC",
        [status]
      )
    : await query("SELECT * FROM slots ORDER BY starts_at ASC");
  return rows.map(toSlot);
}

async function createSlot({ startsAt, endsAt, label, depositAmountCents, status = "open" }) {
  try {
    const { rows } = await query(
      `INSERT INTO slots (starts_at, ends_at, label, deposit_amount_cents, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [startsAt, endsAt, label, depositAmountCents, status]
    );
    return toSlot(rows[0]);
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const duplicateError = new Error(
        "Für diesen Zeitpunkt existiert bereits ein aktiver Slot."
      );
      duplicateError.status = 409;
      throw duplicateError;
    }
    throw error;
  }
}

async function updateDraftSlot(id, { startsAt, endsAt, label, depositAmountCents }) {
  try {
    const { rows } = await query(
      `UPDATE slots
       SET starts_at = $2, ends_at = $3, label = $4, deposit_amount_cents = $5, updated_at = now()
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [id, startsAt, endsAt, label, depositAmountCents]
    );
    return rows[0] ? toSlot(rows[0]) : null;
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const duplicateError = new Error(
        "Für diesen Zeitpunkt existiert bereits ein aktiver Slot."
      );
      duplicateError.status = 409;
      throw duplicateError;
    }
    throw error;
  }
}


async function getSlot(id) {
  const { rows } = await query("SELECT * FROM slots WHERE id = $1", [id]);
  return rows[0] ? toSlot(rows[0]) : null;
}

// Admin may publish a draft/withdrawn slot or withdraw an open slot.
// 'reserved'/'booked' are set by the booking flow and are never changed here.
async function setSlotStatus(id, status) {
  const { rows } = await query(
    `UPDATE slots SET status = $2, updated_at = now()
     WHERE id = $1 AND status IN ('draft', 'open', 'cancelled')
     RETURNING *`,
    [id, status]
  );
  return rows[0] ? toSlot(rows[0]) : null;
}

module.exports = { listSlots, createSlot, updateDraftSlot, getSlot, setSlotStatus };
