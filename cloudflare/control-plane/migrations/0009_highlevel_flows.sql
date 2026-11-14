-- HighLevel OAuth relay flows. A row lives at most ten minutes: created at
-- `start`, filled by the browser callback, emptied by the harness's `claim`,
-- swept by the cron. The random state the harness holds is never stored:
-- `lookup` is an HKDF derivation of it, and `ciphertext` is the token payload
-- sealed with AES-GCM under a second derivation. Without the state, a row
-- opens nothing. No plaintext token is ever written to D1.
CREATE TABLE highlevel_flows (
  lookup TEXT PRIMARY KEY CHECK (length(lookup) = 64),
  ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) BETWEEN 1 AND 65536),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  CHECK (claimed_at IS NULL OR ciphertext IS NULL)
);

CREATE INDEX highlevel_flows_created_idx
  ON highlevel_flows(created_at);

-- The relay routes carry no credential (the state and the tokens are the
-- secrets), so they are limited per caller address. Keys are keyed hashes of
-- the address, never the address itself.
CREATE TABLE highlevel_ip_rate_limits (
  ip_key TEXT NOT NULL CHECK (length(ip_key) = 64),
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ip_key, action)
);

CREATE INDEX highlevel_ip_rate_limits_updated_idx
  ON highlevel_ip_rate_limits(updated_at);
