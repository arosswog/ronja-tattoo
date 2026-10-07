-- Ronja can remove appointments she published or that are long finished, and
-- she can also remove a booked appointment (even with a paid deposit) after a
-- double confirmation. A paid deposit is a money record, so a booked
-- appointment is archived (hidden everywhere, kept internally) instead of
-- being destroyed.
ALTER TABLE slots ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- An archived slot must no longer block a new slot at the same start time.
DROP INDEX IF EXISTS slots_starts_at_unique;
CREATE UNIQUE INDEX IF NOT EXISTS slots_starts_at_unique
  ON slots (starts_at) WHERE status <> 'cancelled' AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS slots_archived_at_idx ON slots (archived_at);
CREATE INDEX IF NOT EXISTS bookings_archived_at_idx ON bookings (archived_at);
