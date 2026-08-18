const { query, withTransaction } = require("../db");

function toBooking(row) {
  return {
    id: row.id,
    slotId: row.slot_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    preferredDate: row.preferred_date,
    placement: row.placement,
    size: row.size,
    designIdea: row.design_idea,
    status: row.status,
    depositStatus: row.deposit_status,
    depositAmountCents: row.deposit_amount_cents,
    submittedAt: row.submitted_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  };
}

async function listBookings() {
  const { rows } = await query(
    `SELECT id, slot_id, name, email, phone, preferred_date, placement, size, design_idea,
            status, deposit_status, deposit_amount_cents, submitted_at, reviewed_at
     FROM bookings
     ORDER BY submitted_at DESC`
  );
  return rows.map(toBooking);
}

// Locks the target slot row (FOR UPDATE) before creating the booking, so two
// customers submitting for the same slot at once are serialized rather than
// racing — the second request sees status != 'open' after the lock and
// aborts cleanly instead of double-booking.
async function createBookingForSlot({
  slotId,
  name,
  email,
  phone,
  placement,
  size,
  designIdea,
}) {
  return withTransaction(async (client) => {
    const { rows: slotRows } = await client.query(
      "SELECT id, starts_at, deposit_amount_cents, status FROM slots WHERE id = $1 FOR UPDATE",
      [slotId]
    );
    const slot = slotRows[0];

    if (!slot) {
      const error = new Error("Der ausgewählte Termin wurde nicht gefunden.");
      error.status = 404;
      throw error;
    }
    if (slot.status !== "open") {
      const error = new Error(
        "Dieser Termin ist gerade nicht mehr verfügbar. Bitte einen anderen wählen."
      );
      error.status = 409;
      throw error;
    }

    await client.query(
      "UPDATE slots SET status = 'booked', updated_at = now() WHERE id = $1",
      [slotId]
    );

    const { rows } = await client.query(
      `INSERT INTO bookings
         (slot_id, name, email, phone, preferred_date, placement, size, design_idea, deposit_amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, slot_id, name, email, phone, preferred_date, placement, size, design_idea,
                 status, deposit_status, deposit_amount_cents, submitted_at, reviewed_at`,
      [
        slotId,
        name,
        email,
        phone,
        slot.starts_at.toISOString(),
        placement,
        size,
        designIdea,
        slot.deposit_amount_cents,
      ]
    );

    return toBooking(rows[0]);
  });
}

// On reject/cancel, releases the linked slot back to 'open' in the same
// transaction as the status change, so the two can never drift apart.
async function updateBookingStatus(id, status) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE bookings
       SET status = $2, reviewed_at = now()
       WHERE id = $1
       RETURNING id, slot_id, name, email, phone, preferred_date, placement, size, design_idea,
                 status, deposit_status, deposit_amount_cents, submitted_at, reviewed_at`,
      [id, status]
    );
    const booking = rows[0];

    if (!booking) {
      return null;
    }

    if (["rejected", "cancelled"].includes(status) && booking.slot_id) {
      await client.query(
        "UPDATE slots SET status = 'open', updated_at = now() WHERE id = $1 AND status = 'booked'",
        [booking.slot_id]
      );
    }

    return toBooking(booking);
  });
}

module.exports = { listBookings, createBookingForSlot, updateBookingStatus };
