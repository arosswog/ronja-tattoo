const { query } = require("../db");

const CUSTOMER_KIND = "customer_confirmation";

function publicDelivery(row) {
  if (!row) return null;
  return {
    status: row.status,
    attemptCount: row.attempt_count,
    error: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

function boundedError(error) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message || error.name || "E-Mail-Versand fehlgeschlagen";
  return String(message).replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

async function recordAttempt({ bookingId, kind, recipient, providerEmailId, status, error }) {
  const { rows } = await query(
    `INSERT INTO email_deliveries
       (booking_id, kind, recipient, provider_email_id, status, last_error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (booking_id, kind) DO UPDATE SET
       recipient = EXCLUDED.recipient,
       provider_email_id = EXCLUDED.provider_email_id,
       status = EXCLUDED.status,
       last_error = EXCLUDED.last_error,
       attempt_count = email_deliveries.attempt_count + 1,
       updated_at = now()
     RETURNING *`,
    [bookingId, kind, recipient, providerEmailId || null, status, boundedError(error)]
  );
  return rows[0];
}

async function reserveCustomerRetry(bookingId, recipient) {
  const { rows } = await query(
    `WITH updated AS (
       UPDATE email_deliveries
       SET status = 'pending', last_error = NULL, provider_email_id = NULL,
           attempt_count = attempt_count + 1, updated_at = now()
       WHERE booking_id = $1 AND kind = $2
         AND status IN ('bounced', 'failed', 'suppressed', 'complained')
       RETURNING *
     ), inserted AS (
       INSERT INTO email_deliveries (booking_id, kind, recipient, status)
       SELECT $1, $2, $3, 'pending'
       WHERE NOT EXISTS (SELECT 1 FROM updated)
       ON CONFLICT (booking_id, kind) DO NOTHING
       RETURNING *
     )
     SELECT * FROM updated UNION ALL SELECT * FROM inserted`,
    [bookingId, CUSTOMER_KIND, recipient]
  );
  return rows[0] || null;
}

async function completeCustomerRetry(bookingId, { providerEmailId, status, error }) {
  const { rows } = await query(
    `UPDATE email_deliveries
     SET provider_email_id = $2, status = $3, last_error = $4, updated_at = now()
     WHERE booking_id = $1 AND kind = $5 AND status = 'pending'
     RETURNING *`,
    [bookingId, providerEmailId || null, status, boundedError(error), CUSTOMER_KIND]
  );
  return rows[0] || null;
}

async function updateProviderStatus(providerEmailId, status, error = null, eventAt = null) {
  const { rows } = await query(
    `UPDATE email_deliveries
     SET status = $2, last_error = $3, provider_event_at = $4, updated_at = now()
     WHERE provider_email_id = $1
       AND (provider_event_at IS NULL OR provider_event_at <= $4)
     RETURNING *`,
    [providerEmailId, status, boundedError(error), eventAt]
  );
  return rows[0] || null;
}

async function deliveryForBookingKind(bookingId, kind) {
  const { rows } = await query(
    `SELECT * FROM email_deliveries WHERE booking_id = $1 AND kind = $2`,
    [bookingId, kind]
  );
  return publicDelivery(rows[0]);
}

async function customerDeliveryForBooking(bookingId) {
  return deliveryForBookingKind(bookingId, CUSTOMER_KIND);
}

async function deliveriesForBookings(bookingIds) {
  if (!bookingIds.length) return new Map();
  const { rows } = await query(
    `SELECT * FROM email_deliveries WHERE booking_id = ANY($1::uuid[])`,
    [bookingIds]
  );
  const byBooking = new Map();
  for (const row of rows) {
    if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, {});
    byBooking.get(row.booking_id)[row.kind] = publicDelivery(row);
  }
  return byBooking;
}

module.exports = {
  CUSTOMER_KIND,
  boundedError,
  recordAttempt,
  reserveCustomerRetry,
  completeCustomerRetry,
  updateProviderStatus,
  deliveryForBookingKind,
  customerDeliveryForBooking,
  deliveriesForBookings,
};
