-- One row per Composio trigger instance an installation listens to. Composio
-- returns the same instance for an identical config, so the OMB server counts
-- its own local triggers per instance and keeps one binding here.
CREATE TABLE trigger_bindings (
  installation_id      TEXT NOT NULL REFERENCES installations(id),
  composio_trigger_id  TEXT NOT NULL,
  toolkit              TEXT NOT NULL,
  trigger_slug         TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  disabled_at          INTEGER,
  PRIMARY KEY (installation_id, composio_trigger_id)
);
CREATE INDEX trigger_bindings_trigger_idx ON trigger_bindings(composio_trigger_id);
CREATE INDEX trigger_bindings_account_idx ON trigger_bindings(connected_account_id);

-- The per-installation queue. seq order is delivery order. An acked row keeps
-- only its id (body emptied) until it is 7 days old, so a late Composio retry
-- of an event already delivered is still recognised as a duplicate.
CREATE TABLE events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id     TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  kind                TEXT NOT NULL,
  composio_trigger_id TEXT,
  received_at         INTEGER NOT NULL,
  bytes               INTEGER NOT NULL,
  body                TEXT NOT NULL,
  acked_at            INTEGER,
  UNIQUE (installation_id, event_id)
);
CREATE INDEX events_pending_idx ON events(installation_id, seq, bytes) WHERE acked_at IS NULL;
CREATE INDEX events_received_idx ON events(received_at);

-- Events not delivered, per trigger binding and reason
-- (daily_limit | queue_full | expired), so the app can show them on the trigger.
CREATE TABLE event_drops (
  installation_id     TEXT NOT NULL,
  composio_trigger_id TEXT NOT NULL,
  reason              TEXT NOT NULL,
  dropped             INTEGER NOT NULL,
  last_dropped_at     INTEGER NOT NULL,
  PRIMARY KEY (installation_id, composio_trigger_id, reason)
);

-- Daily counts per installation (UTC day), which also enforce the daily limit.
-- installation_id '' holds deliveries no installation owns. Counts only, never
-- event contents; the fleet totals for Admin are sums over this table.
CREATE TABLE app_event_days (
  day                 TEXT NOT NULL,
  installation_id     TEXT NOT NULL,
  queued              INTEGER NOT NULL DEFAULT 0,
  delivered           INTEGER NOT NULL DEFAULT 0,
  duplicate           INTEGER NOT NULL DEFAULT 0,
  dropped_daily_limit INTEGER NOT NULL DEFAULT 0,
  dropped_queue_full  INTEGER NOT NULL DEFAULT 0,
  expired             INTEGER NOT NULL DEFAULT 0,
  unrouted            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, installation_id)
);

ALTER TABLE installations ADD COLUMN events_polled_at INTEGER;
ALTER TABLE installations ADD COLUMN poll_lease_id TEXT;
ALTER TABLE installations ADD COLUMN poll_lease_until INTEGER;
ALTER TABLE installations ADD COLUMN triggers_swept_at INTEGER;
-- Set from an Admin-signed grant: the installation is a paid Cloud's.
ALTER TABLE installations ADD COLUMN cloud_machine_id TEXT;
CREATE UNIQUE INDEX installations_cloud_machine_idx ON installations(cloud_machine_id) WHERE cloud_machine_id IS NOT NULL;
