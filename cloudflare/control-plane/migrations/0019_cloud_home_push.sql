-- Phone push for Cloud homes (README "Phone push relay", "Cloud homes"). A
-- Cloud home has no installation: the Admin relays its pushes, keyed by the
-- home's machine id, with the one secret it shares with this Worker. Same
-- shape as installation_push_devices, with machine_id for installation_id and
-- no foreign key (a machine lives in the Admin, not here). Additive: nothing
-- an installation reads or writes changes.
CREATE TABLE machine_push_devices (
  machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 3 AND 128),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  platform TEXT NOT NULL DEFAULT 'apns' CHECK (platform IN ('apns', 'fcm')),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 64 AND 4096),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  purpose TEXT NOT NULL DEFAULT 'alert' CHECK (purpose IN ('alert', 'activity', 'activity-start')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  PRIMARY KEY (machine_id, token_hash)
);

CREATE INDEX machine_push_devices_token_idx
  ON machine_push_devices(token_hash);

-- The same hourly windows as installation_action_rate_limits, per machine.
-- The row with machine_id '*' (no machine id can be '*') is the whole fleet's.
CREATE TABLE machine_push_rate_limits (
  machine_id TEXT NOT NULL,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, action)
);

CREATE INDEX machine_push_rate_limits_updated_idx
  ON machine_push_rate_limits(updated_at);
