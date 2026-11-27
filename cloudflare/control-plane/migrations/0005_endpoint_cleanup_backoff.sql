-- Scheduled endpoint cleanup retries use a dedicated counter and attempt
-- timestamp for bounded exponential backoff.
ALTER TABLE installation_endpoints
  ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0);

ALTER TABLE installation_endpoints
  ADD COLUMN last_cleanup_attempt_at INTEGER;
