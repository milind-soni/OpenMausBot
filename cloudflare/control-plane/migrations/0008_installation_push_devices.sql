-- APNs device tokens an installation registered for closed-app phone alerts.
-- A token belongs to the installation that registered it: another
-- installation can push to the same phone only by registering it itself.
CREATE TABLE installation_push_devices (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 64 AND 200),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  PRIMARY KEY (installation_id, token_hash)
);

CREATE INDEX installation_push_devices_token_idx
  ON installation_push_devices(token_hash);
