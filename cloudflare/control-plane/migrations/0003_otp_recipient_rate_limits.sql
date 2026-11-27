-- A recipient-scoped limit complements Better Auth's IP limits so distributed
-- callers cannot repeatedly rotate and send codes to one email address.
-- Recipient keys are HMACs, never plaintext addresses.
CREATE TABLE otp_recipient_rate_limits (
  recipient_key TEXT PRIMARY KEY CHECK (length(recipient_key) = 64),
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX otp_recipient_rate_limits_updated_idx
  ON otp_recipient_rate_limits(updated_at);

-- Authenticated accounts are still untrusted. Bound installation row churn
-- separately from Better Auth's public endpoint limits.
CREATE TABLE control_action_rate_limits (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);
