-- Tool calls a MausBot account's phones made on `day` (UTC): one row per account, reset by its first call of a new day.
CREATE TABLE account_tool_calls (
  account_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL
);
-- The last sign-in link a MausBot account's phones opened for each app: one minted in the last 15 minutes counts toward
-- the account's app allowance until it finishes.
CREATE TABLE account_links (
  account_id TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  minted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, toolkit)
);
-- The installations acting as a user shared with them, which a revoke disables along with the account's phones.
CREATE INDEX installations_shared_user_idx ON installations(shared_user_id) WHERE shared_user_id IS NOT NULL;
