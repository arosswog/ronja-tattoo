-- Manually published appointment slots. Ronja creates and opens/closes
-- these herself in the admin panel — nothing here is automatic.
-- 'reserved' and 'booked' are part of the enum now (cheap to add up front,
-- expensive to ALTER TYPE later) but are not reachable yet; they become
-- reachable once bookings are wired to slots (deposit/booking flow, next).

CREATE TYPE slot_status AS ENUM ('open', 'reserved', 'booked', 'cancelled');

CREATE TABLE IF NOT EXISTS slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  deposit_amount_cents INT NOT NULL,
  status slot_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT slots_time_valid CHECK (ends_at > starts_at),
  CONSTRAINT slots_deposit_non_negative CHECK (deposit_amount_cents >= 0)
);

-- Prevents publishing two active (non-cancelled) slots at the exact same
-- start time — the same race-safety principle the bookings table will get
-- once slot-locking lands.
CREATE UNIQUE INDEX IF NOT EXISTS slots_starts_at_unique
  ON slots (starts_at) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS slots_status_starts_at_idx ON slots (status, starts_at);
