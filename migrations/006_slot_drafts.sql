-- Draft appointment slots are private admin records until Ronja explicitly publishes them.
-- The existing partial unique index includes every status except cancelled, so draft and
-- open slots cannot accidentally share the same start time.
ALTER TYPE slot_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'open';
