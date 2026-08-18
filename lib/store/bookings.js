const { query } = require("../db");

function toBooking(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    preferredDate: row.preferred_date,
    placement: row.placement,
    size: row.size,
    designIdea: row.design_idea,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  };
}

async function listBookings() {
  const { rows } = await query(
    `SELECT id, name, email, phone, preferred_date, placement, size, design_idea,
            status, submitted_at, reviewed_at
     FROM bookings
     ORDER BY submitted_at DESC`
  );
  return rows.map(toBooking);
}

async function createBooking({
  name,
  email,
  phone,
  preferredDate,
  placement,
  size,
  designIdea,
}) {
  const { rows } = await query(
    `INSERT INTO bookings (name, email, phone, preferred_date, placement, size, design_idea)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, email, phone, preferred_date, placement, size, design_idea,
               status, submitted_at, reviewed_at`,
    [name, email, phone, preferredDate, placement, size, designIdea]
  );
  return toBooking(rows[0]);
}

async function updateBookingStatus(id, status) {
  const { rows } = await query(
    `UPDATE bookings
     SET status = $2, reviewed_at = now()
     WHERE id = $1
     RETURNING id, name, email, phone, preferred_date, placement, size, design_idea,
               status, submitted_at, reviewed_at`,
    [id, status]
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

module.exports = { listBookings, createBooking, updateBookingStatus };
