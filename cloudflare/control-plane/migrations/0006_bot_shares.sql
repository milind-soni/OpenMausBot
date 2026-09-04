-- Shared bots remain portable BotMRR Markdown. D1 stores ownership, discovery
-- state, and immutable snapshots; it is not a second bot registry.
CREATE TABLE bot_shares (
  id TEXT PRIMARY KEY CHECK (length(id) = 21 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK (visibility IN ('unlisted', 'private')),
  active_version INTEGER NOT NULL CHECK (active_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX bot_shares_owner_active_idx
  ON bot_shares(owner_user_id, deleted_at, updated_at DESC);

-- Quotas live in D1 triggers rather than a read-then-write application check,
-- so concurrent publish requests cannot race past the same limit.
CREATE TRIGGER bot_shares_owner_limit_before_insert
BEFORE INSERT ON bot_shares
WHEN (
  SELECT COUNT(*)
    FROM bot_shares
   WHERE owner_user_id = NEW.owner_user_id
     AND deleted_at IS NULL
) >= 100
BEGIN
  SELECT RAISE(ABORT, 'bot_share_owner_limit');
END;

CREATE TABLE bot_share_versions (
  share_id TEXT NOT NULL REFERENCES bot_shares(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  package_markdown TEXT NOT NULL,
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 64),
  package_bytes INTEGER NOT NULL CHECK (package_bytes BETWEEN 1 AND 1000000),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, version)
);

CREATE TRIGGER bot_share_versions_limit_before_insert
BEFORE INSERT ON bot_share_versions
WHEN (
  SELECT COUNT(*)
    FROM bot_share_versions
   WHERE share_id = NEW.share_id
) >= 50
BEGIN
  SELECT RAISE(ABORT, 'bot_share_version_limit');
END;

-- A version insert and the active pointer advance happen in one D1 statement.
-- Concurrent writers that started from the same expected version cannot both
-- succeed, and no version can be inserted behind the active pointer.
CREATE TRIGGER bot_share_versions_expected_active_before_insert
BEFORE INSERT ON bot_share_versions
WHEN NEW.version > 1 AND NOT EXISTS (
  SELECT 1
    FROM bot_shares
   WHERE id = NEW.share_id
     AND deleted_at IS NULL
     AND active_version = NEW.version - 1
)
BEGIN
  SELECT RAISE(ABORT, 'bot_share_version_conflict');
END;

CREATE TRIGGER bot_share_versions_advance_after_insert
AFTER INSERT ON bot_share_versions
WHEN NEW.version > 1
BEGIN
  UPDATE bot_shares
     SET active_version = NEW.version,
         updated_at = NEW.created_at
   WHERE id = NEW.share_id
     AND deleted_at IS NULL
     AND active_version = NEW.version - 1;
END;
