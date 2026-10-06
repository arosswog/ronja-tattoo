-- Durable provider status for every email tied to a booking. The current customer
-- confirmation is shown in the admin UI; owner/deposit kinds use the same audit table.
CREATE TABLE IF NOT EXISTS email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'customer_confirmation',
    'owner_notification',
    'deposit_request',
    'deposit_received_customer',
    'deposit_received_owner'
  )),
  recipient TEXT NOT NULL,
  provider_email_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'sent', 'delivered', 'delivery_delayed',
    'bounced', 'failed', 'suppressed', 'complained'
  )),
  last_error TEXT,
  attempt_count INT NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, kind)
);

CREATE INDEX IF NOT EXISTS email_deliveries_provider_id_idx
  ON email_deliveries (provider_email_id)
  WHERE provider_email_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_deliveries_booking_idx
  ON email_deliveries (booking_id);
