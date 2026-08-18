-- Storage foundation: replaces the /tmp-backed JSON files (data/admin.json,
-- data/bookings.json, data/gallery.json) and the in-memory sessions Map with
-- real, persistent, race-safe Postgres tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admin_account (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  configured BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ
);
INSERT INTO admin_account (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS gallery_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  image TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same fields as today's bookings.json entries (preferred_date stays free
-- text for now — slot linkage arrives in a later migration once the slots
-- feature is built). Getting real bookings onto Postgres now, in this first
-- migration, is deliberate: it is the single most important data to stop
-- losing, and it does not need to wait for the slots/waitlist/deposit work.
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  preferred_date TEXT NOT NULL,
  placement TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  design_idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bookings_submitted_at_idx ON bookings (submitted_at DESC);

-- Default gallery placeholders are seeded by lib/seed.js, not here.
-- Migrations run exactly once per file (tracked in schema_migrations), but
-- both local dev resets and the test suite need the seed data reinstated
-- after every TRUNCATE — that needs a repeatable seed step, not a
-- one-time migration.
