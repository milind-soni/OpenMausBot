-- Managed endpoints in more than one Cloudflare account.
--
-- Every endpoint row names the account that holds its tunnel and DNS record,
-- by account ID, and keeps it for life: renewal, re-provisioning after an
-- idle reclaim, cleanup, and the idle scan all act in that account. The
-- default is the account every endpoint created before this migration lives
-- in, so existing rows (and inserts by a Worker deployed before this change)
-- keep their account. A row whose account is not configured refuses to act.
ALTER TABLE installation_endpoints
  ADD COLUMN provider_account TEXT NOT NULL DEFAULT '0c92969a82eb9e173b013a7e7a02333d'
  CHECK (length(provider_account) = 32);

CREATE INDEX installation_endpoints_account_status_idx
  ON installation_endpoints(provider_account, status);

-- Capacity state per account, replacing the one-row managed_endpoint_capacity
-- (kept, no longer written, so a Worker from before this migration still
-- runs against this schema). Counts, timestamps, and the account ID only.
-- `dormant_endpoints` counts endpoints of active installations whose tunnel
-- is gone: a returning owner needs a slot in that same account.
CREATE TABLE managed_endpoint_account_capacity (
  provider_account TEXT PRIMARY KEY CHECK (length(provider_account) = 32),
  scan_page INTEGER NOT NULL DEFAULT 1 CHECK (scan_page >= 1),
  tunnel_count INTEGER CHECK (tunnel_count IS NULL OR tunnel_count >= 0),
  dns_record_count INTEGER CHECK (dns_record_count IS NULL OR dns_record_count >= 0),
  reclaim_pending INTEGER NOT NULL DEFAULT 0 CHECK (reclaim_pending >= 0),
  dormant_endpoints INTEGER NOT NULL DEFAULT 0 CHECK (dormant_endpoints >= 0),
  checked_at INTEGER,
  capacity_rejected_at INTEGER,
  capacity_rejected_code TEXT CHECK (
    capacity_rejected_code IS NULL OR length(capacity_rejected_code) BETWEEN 1 AND 64
  ),
  updated_at INTEGER NOT NULL
);

-- Carry the existing snapshot, scan cursor, and any active refusal over to
-- that same account.
INSERT INTO managed_endpoint_account_capacity
  (provider_account, scan_page, tunnel_count, dns_record_count, reclaim_pending,
   checked_at, capacity_rejected_at, capacity_rejected_code, updated_at)
SELECT '0c92969a82eb9e173b013a7e7a02333d', scan_page, tunnel_count, dns_record_count,
       reclaim_pending, checked_at, capacity_rejected_at, capacity_rejected_code, updated_at
  FROM managed_endpoint_capacity
 WHERE id = 1;
