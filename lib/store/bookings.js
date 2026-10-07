const { query, withTransaction } = require("../db");

const BOOKING_COLUMNS = `
  id, slot_id, name, email, instagram, preferred_date, placement, size, design_idea,
  reference_images, status, deposit_status, deposit_amount_cents,
  stripe_checkout_session_id, stripe_payment_intent_id, stripe_recovery_url,
  submitted_at, reviewed_at, archived_at
  `;

function toBooking(row) {
  return {
    id: row.id,
    slotId: row.slot_id,
    name: row.name,
    email: row.email,
    instagram: row.instagram,
    preferredDate: row.preferred_date,
    placement: row.placement,
    size: row.size,
    designIdea: row.design_idea,
    referenceImages: row.reference_images || [],
    status: row.status,
    depositStatus: row.deposit_status,
    depositAmountCents: row.deposit_amount_cents,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeRecoveryUrl: row.stripe_recovery_url,
    submittedAt: row.submitted_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  };
}

async function listBookings() {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE archived_at IS NULL ORDER BY submitted_at DESC`
  );
  return rows.map(toBooking);
}

async function getBooking(id) {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
    [id]
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

async function getBookingByStripeSession(sessionId) {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE stripe_checkout_session_id = $1`,
    [sessionId]
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

async function updateDepositStatus(id, { depositStatus, stripeCheckoutSessionId, stripePaymentIntentId }) {
  const { rows } = await query(
    `UPDATE bookings
     SET deposit_status = $2,
         stripe_checkout_session_id = COALESCE($3, stripe_checkout_session_id),
         stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id)
     WHERE id = $1
     RETURNING ${BOOKING_COLUMNS}`,
    [id, depositStatus, stripeCheckoutSessionId ?? null, stripePaymentIntentId ?? null]
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

// Locks the target slot row (FOR UPDATE) before creating the booking, so two
// customers submitting for the same slot at once are serialized rather than
// racing — the second request sees status != 'open' after the lock and
// aborts cleanly instead of double-booking.
async function createBookingForSlot({
  slotId,
  name,
  email,
  instagram,
  placement,
  size,
  designIdea,
  referenceImages = [],
}) {
  return withTransaction(async (client) => {
    const { rows: slotRows } = await client.query(
      `SELECT id, starts_at, deposit_amount_cents, status FROM slots
       WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
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
         (slot_id, name, email, instagram, preferred_date, placement, size, design_idea, deposit_amount_cents, reference_images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        slotId,
        name,
        email,
        instagram,
        slot.starts_at.toISOString(),
        placement,
        size,
        designIdea,
        slot.deposit_amount_cents,
        referenceImages,
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
       RETURNING ${BOOKING_COLUMNS}`,
      [id, status]
    );
    const booking = rows[0];

    if (!booking) {
      return null;
    }

    if (["rejected", "cancelled"].includes(status) && booking.slot_id) {
      await client.query(
        `UPDATE slots SET status = 'open', updated_at = now()
         WHERE id = $1 AND status = 'booked'
           AND NOT EXISTS (
             SELECT 1 FROM bookings b
             WHERE b.slot_id = $1 AND b.id <> $2 AND b.status IN ('pending', 'approved')
               AND b.archived_at IS NULL
           )`,
        [booking.slot_id, booking.id]
      );
    }

    // Approving must reserve the slot again: without this, a booking that was
    // rejected or cancelled earlier stays visible as a free appointment even
    // though it is live again.
    if (status === "approved" && booking.slot_id) {
      await client.query(
        `UPDATE slots SET status = 'booked', updated_at = now()
         WHERE id = $1 AND status = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM bookings b
             WHERE b.slot_id = $1 AND b.id <> $2 AND b.status IN ('pending', 'approved')
               AND b.archived_at IS NULL
           )`,
        [booking.slot_id, booking.id]
      );
    }

    return toBooking(booking);
  });
}

// An expired deposit link must not cost the customer her appointment. The
// booking stays approved and the slot stays reserved; only the deposit state
// changes, and Stripe's recovery URL (30 days) is stored for a re-send.
async function markDepositExpired(id, recoveryUrl = null) {
  const { rows } = await query(
    `UPDATE bookings
     SET deposit_status = 'expired',
         stripe_recovery_url = COALESCE($2, stripe_recovery_url)
     WHERE id = $1 AND status = 'approved' AND deposit_status <> 'paid'
     RETURNING ${BOOKING_COLUMNS}`,
    [id, recoveryUrl]
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

module.exports = {
  listBookings,
  getBooking,
  getBookingByStripeSession,
  createBookingForSlot,
  updateBookingStatus,
  updateDepositStatus,
  markDepositExpired,
};
