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

async function createSlot({ startsAt, endsAt, label, depositAmountCents }) {
  try {
    const { rows } = await query(
      `INSERT INTO slots (starts_at, ends_at, label, deposit_amount_cents)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [startsAt, endsAt, label, depositAmountCents]
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

async function getSlot(id) {
  const { rows } = await query("SELECT * FROM slots WHERE id = $1", [id]);
  return rows[0] ? toSlot(rows[0]) : null;
}

// Only the two admin-reachable transitions in this phase: publish (open) and
// withdraw (cancelled). 'reserved'/'booked' are set by the booking flow, not
// this function — callers must not pass them here yet.
async function setSlotStatus(id, status) {
  const { rows } = await query(
    `UPDATE slots SET status = $2, updated_at = now()
     WHERE id = $1 AND status IN ('open', 'cancelled')
     RETURNING *`,
    [id, status]
  );
  return rows[0] ? toSlot(rows[0]) : null;
}

module.exports = { listSlots, createSlot, getSlot, setSlotStatus };
