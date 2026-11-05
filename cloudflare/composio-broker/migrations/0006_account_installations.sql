-- A phone's installation bound by an Admin-signed account grant: it acts as shared_user_id = 'omb_acct_' || account_id
-- until account_until (ms); a fresh grant renews it.
ALTER TABLE installations ADD COLUMN account_id TEXT;
ALTER TABLE installations ADD COLUMN account_until INTEGER;
CREATE INDEX installations_account_idx ON installations(account_id) WHERE account_id IS NOT NULL;
-- Accounts the Cloud Admin deleted: a grant minted before the deletion is refused. attempted_at: the last cleanup run
-- that tried to delete the account's sign-ins. cleared_at: Composio listed no connected account left for its user.
CREATE TABLE revoked_accounts (
  account_id TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL,
  attempted_at INTEGER,
  cleared_at INTEGER
);
