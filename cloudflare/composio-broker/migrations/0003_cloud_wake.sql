-- When the broker last asked the Cloud Admin to wake this installation's Cloud for a queued event (ms), so it asks at
-- most once a minute.
ALTER TABLE installations ADD COLUMN wake_requested_at INTEGER;
