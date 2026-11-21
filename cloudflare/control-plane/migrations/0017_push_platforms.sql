-- FCM registration tokens beside APNs device tokens. An FCM token is longer
-- than the old CHECK allowed and is not hex, and SQLite cannot change a
-- CHECK in place, so the table is rebuilt with every row kept as 'apns'.
-- `environment` stays 'production' for an FCM token: FCM has one.
CREATE TABLE installation_push_devices_next (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  platform TEXT NOT NULL DEFAULT 'apns' CHECK (platform IN ('apns', 'fcm')),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 64 AND 4096),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  PRIMARY KEY (installation_id, token_hash)
);

INSERT INTO installation_push_devices_next
  (installation_id, token_hash, platform, token, environment, created_at, updated_at, last_sent_at)
SELECT installation_id, token_hash, 'apns', token, environment, created_at, updated_at, last_sent_at
  FROM installation_push_devices;

DROP TABLE installation_push_devices;

ALTER TABLE installation_push_devices_next RENAME TO installation_push_devices;

CREATE INDEX installation_push_devices_token_idx
  ON installation_push_devices(token_hash);
