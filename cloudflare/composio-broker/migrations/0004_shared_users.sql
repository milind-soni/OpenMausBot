-- The Composio user this installation acts as, when the person's desktop shared its own with their Cloud. NULL: its
-- own, composio_user_id, which it keeps either way.
ALTER TABLE installations ADD COLUMN shared_user_id TEXT;

-- One-time codes an installation mints so that one other installation can act as its Composio user. Only the hash is
-- kept; a code is deleted when it is used, and expired ones when the next code is minted.
CREATE TABLE user_shares (
  code_hash         TEXT PRIMARY KEY,
  from_installation TEXT NOT NULL,
  for_installation  TEXT NOT NULL,
  composio_user_id  TEXT NOT NULL,
  expires_at        INTEGER NOT NULL
);
CREATE INDEX user_shares_expiry_idx ON user_shares(expires_at);
