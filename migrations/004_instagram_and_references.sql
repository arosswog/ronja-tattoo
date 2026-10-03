ALTER TABLE bookings RENAME COLUMN phone TO instagram;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference_images TEXT[] NOT NULL DEFAULT '{}';
