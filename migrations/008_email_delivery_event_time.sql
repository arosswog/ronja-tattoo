-- Webhook delivery is at-least-once and may arrive out of order. Keep the provider's
-- event time so a delayed older failure cannot overwrite a newer delivered status.
ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS provider_event_at TIMESTAMPTZ;
