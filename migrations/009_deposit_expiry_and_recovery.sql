-- An expired deposit link must not cancel the appointment. It becomes its own
-- state instead, and Stripe's recovery URL (valid 30 days) is kept so the link
-- can be re-sent without asking the customer to book again.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS stripe_recovery_url TEXT;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'bookings'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%deposit_status%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE bookings
    ADD CONSTRAINT bookings_deposit_status_check
    CHECK (deposit_status IN ('none', 'pending', 'paid', 'refunded', 'failed', 'expired'));
END $$;
