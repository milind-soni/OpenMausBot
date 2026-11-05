-- Tool calls a MausBot account's phones made on `day` (UTC): one row per account, reset by its first call of a new day.
CREATE TABLE account_tool_calls (
  account_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL
);
