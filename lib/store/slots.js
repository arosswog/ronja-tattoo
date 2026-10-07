const { query, withTransaction } = require("../db");

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
        "SELECT * FROM slots WHERE status = $1 AND archived_at IS NULL ORDER BY starts_at ASC",
        [status]
      )
    : await query("SELECT * FROM slots WHERE archived_at IS NULL ORDER BY starts_at ASC");
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
       WHERE id = $1 AND status = 'draft' AND archived_at IS NULL
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
  const { rows } = await query(
    "SELECT * FROM slots WHERE id = $1 AND archived_at IS NULL",
    [id]
  );
  return rows[0] ? toSlot(rows[0]) : null;
}

// Admin may publish a draft/withdrawn slot or withdraw an open slot.
// 'reserved'/'booked' are set by the booking flow and are never changed here.
async function setSlotStatus(id, status) {
  const { rows } = await query(
    `UPDATE slots SET status = $2, updated_at = now()
     WHERE id = $1 AND status IN ('draft', 'open', 'cancelled') AND archived_at IS NULL
     RETURNING *`,
    [id, status]
  );
  return rows[0] ? toSlot(rows[0]) : null;
}

// What would disappear if this appointment were removed? The admin UI shows
// this in the second confirmation step, so the answer to "did I really mean
// this one?" includes the customer and the money involved.
async function deletionImpact(slotId) {
  const { rows } = await query(
    `SELECT id, name, status, deposit_status, deposit_amount_cents, preferred_date
     FROM bookings
     WHERE slot_id = $1 AND archived_at IS NULL
     ORDER BY submitted_at DESC`,
    [slotId]
  );
  const booking = rows[0] || null;
  return {
    bookingCount: rows.length,
    activeBooking: Boolean(booking && ["pending", "approved"].includes(booking.status)),
    depositPaid: rows.some((row) => row.deposit_status === "paid"),
    depositAmountCents: booking ? booking.deposit_amount_cents : null,
    booking: booking
      ? {
          id: booking.id,
          name: booking.name,
          status: booking.status,
          depositStatus: booking.deposit_status,
          preferredDate: booking.preferred_date,
        }
      : null,
  };
}

// No booking attached: nothing to preserve, so the row can go for good.
async function deleteSlot(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM bookings WHERE slot_id = $1 AND archived_at IS NULL",
      [id]
    );
    if (rows[0].n > 0) {
      const error = new Error(
        "Dieser Termin hat eine Buchung und darf nur nach doppelter Bestätigung entfernt werden."
      );
      error.status = 409;
      throw error;
    }
    const deleted = await client.query(
      "DELETE FROM slots WHERE id = $1 AND archived_at IS NULL RETURNING id",
      [id]
    );
    return deleted.rowCount > 0;
  });
}

// Booked appointment: hide it everywhere but keep the booking row (and with it
// the Stripe ids and the paid amount) as the payment record.
async function archiveSlot(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE slots SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND archived_at IS NULL
       RETURNING *`,
      [id]
    );
    if (!rows[0]) return null;

    await client.query(
      "UPDATE bookings SET archived_at = now() WHERE slot_id = $1 AND archived_at IS NULL",
      [id]
    );
    return toSlot(rows[0]);
  });
}

module.exports = {
  listSlots,
  createSlot,
  updateDraftSlot,
  getSlot,
  setSlotStatus,
  deletionImpact,
  deleteSlot,
  archiveSlot,
};
