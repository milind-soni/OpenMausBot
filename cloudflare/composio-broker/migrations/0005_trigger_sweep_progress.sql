-- When the idle sweep disabled this binding's trigger at Composio, so a sweep
-- spread over several hourly runs resumes where it stopped, and the
-- installation's next poll re-enables exactly what was swept. disabled_at
-- stays the server's wish.
ALTER TABLE trigger_bindings ADD COLUMN swept_at INTEGER;
UPDATE trigger_bindings SET swept_at = (SELECT i.triggers_swept_at FROM installations i WHERE i.id = installation_id)
WHERE disabled_at IS NULL;
