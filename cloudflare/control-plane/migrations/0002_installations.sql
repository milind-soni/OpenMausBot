-- Local bots, chats, and desktop state deliberately do not belong here. This
-- database records only cloud account ownership and revocable installation
-- credentials.
CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  client_instance_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'windows', 'linux')),
  app_version TEXT CHECK (app_version IS NULL OR length(app_version) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_rotation_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX installations_owner_active_idx
  ON installations(owner_user_id, revoked_at, created_at);

CREATE UNIQUE INDEX installations_owner_client_active_uidx
  ON installations(owner_user_id, client_instance_id)
  WHERE revoked_at IS NULL;

-- Keep the unpaginated management surface complete and put a hard ceiling on
-- account abuse. The trigger makes the limit atomic across concurrent creates.
CREATE TRIGGER installations_active_limit_before_insert
BEFORE INSERT ON installations
WHEN NEW.revoked_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM installations
    WHERE owner_user_id = NEW.owner_user_id AND revoked_at IS NULL
  ) >= 100
BEGIN
  SELECT RAISE(ABORT, 'active_installation_limit');
END;

-- The first rotation is immediate. Later rotations are serialized and limited
-- so concurrent requests never both return credentials while one revokes the
-- other before it reaches the client.
CREATE TRIGGER installations_rotation_cooldown_before_update
BEFORE UPDATE OF last_rotation_at ON installations
WHEN OLD.last_rotation_at IS NOT NULL
  AND NEW.last_rotation_at < OLD.last_rotation_at + 60000
BEGIN
  SELECT RAISE(ABORT, 'credential_rotation_rate_limited');
END;

CREATE TABLE installation_credentials (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  lookup_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX installation_credentials_installation_idx
  ON installation_credentials(installation_id, revoked_at);

CREATE UNIQUE INDEX installation_credentials_one_active_uidx
  ON installation_credentials(installation_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER installation_credentials_rotation_guard_before_insert
BEFORE INSERT ON installation_credentials
WHEN EXISTS (
    SELECT 1 FROM installation_credentials
    WHERE installation_id = NEW.installation_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM installations
    WHERE id = NEW.installation_id
      AND revoked_at IS NULL
      AND last_rotation_at = NEW.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_rotation_conflict');
END;
