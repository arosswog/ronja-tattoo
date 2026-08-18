-- Wires bookings to real slots instead of a free-text date, and adds the
-- deposit/Stripe columns up front (even though the deposit flow itself
-- lands in a later migration-free step) so the schema doesn't need a
-- second disruptive ALTER once Stripe checkout is wired in.

ALTER TABLE bookings
  ADD COLUMN slot_id UUID REFERENCES slots(id),
  ADD COLUMN deposit_status TEXT NOT NULL DEFAULT 'none'
    CHECK (deposit_status IN ('none', 'pending', 'paid', 'refunded', 'failed')),
  ADD COLUMN deposit_amount_cents INT,
  ADD COLUMN stripe_checkout_session_id TEXT,
  ADD COLUMN stripe_payment_intent_id TEXT,
  ADD COLUMN reservation_expires_at TIMESTAMPTZ;

-- 'cancelled' (approved booking withdrawn by admin) and 'expired' (unpaid
-- deposit reservation lapsed, added ahead of the Stripe step) join the
-- original three states.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired'));

-- Only one active (non-terminal) booking may hold a given slot at a time —
-- the database-level backstop behind the FOR UPDATE lock in
-- createBookingForSlot().
CREATE UNIQUE INDEX bookings_active_slot_unique ON bookings (slot_id)
  WHERE status IN ('pending', 'approved') AND slot_id IS NOT NULL;
CREATE INDEX bookings_slot_id_idx ON bookings (slot_id);
