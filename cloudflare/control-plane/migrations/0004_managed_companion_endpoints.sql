-- Remotely managed Cloudflare Tunnel metadata for one companion endpoint per
-- installation. Connector tokens and Cloudflare API credentials must never be
-- written to D1.
CREATE TABLE installation_endpoints (
  -- Deliberately not cascaded: a hard account/installation deletion must not
  -- erase the Cloudflare resource IDs required for operator cleanup retries.
  installation_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  tunnel_name TEXT NOT NULL UNIQUE,
  tunnel_id TEXT UNIQUE,
  dns_record_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'provisioning', 'ready', 'deleting', 'deleted', 'error')
  ),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_reconciled_at INTEGER,
  delete_requested_at INTEGER,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX installation_endpoints_status_lease_idx
  ON installation_endpoints(status, lease_expires_at, updated_at);

-- Endpoint mutations are installation-authenticated, so they use a separate
-- limiter from the account-scoped actions in control_action_rate_limits.
CREATE TABLE installation_action_rate_limits (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, action)
);

CREATE INDEX installation_action_rate_limits_updated_idx
  ON installation_action_rate_limits(updated_at);
