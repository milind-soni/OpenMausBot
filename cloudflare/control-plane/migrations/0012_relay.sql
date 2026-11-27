-- MausBot Relay: each installation gets one stable relay host id the first time it asks for a relay token, and the
-- adoption counts that gate retiring the tunnel path. The counts carry no device identifiers.
ALTER TABLE installations ADD COLUMN relay_host_id TEXT;
ALTER TABLE installations ADD COLUMN relay_blocked_at INTEGER;

CREATE UNIQUE INDEX installations_relay_host_id_uidx
  ON installations(relay_host_id)
  WHERE relay_host_id IS NOT NULL;

CREATE TABLE relay_adoption (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  app_version TEXT NOT NULL CHECK (length(app_version) BETWEEN 1 AND 32),
  e2e_devices INTEGER NOT NULL CHECK (e2e_devices BETWEEN 0 AND 100),
  legacy_devices INTEGER NOT NULL CHECK (legacy_devices BETWEEN 0 AND 100),
  continent TEXT CHECK (continent IS NULL OR length(continent) = 2),
  updated_at INTEGER NOT NULL
);

CREATE INDEX relay_adoption_updated_idx ON relay_adoption(updated_at);
