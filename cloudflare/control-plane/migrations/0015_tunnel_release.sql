-- Releasing tunnels that relay users no longer need, and a dry-run count for idle reclaim.
--
-- `legacy_clear_at` is since when an installation has reported no old phone (one that still needs the tunnel). It is
-- kept while the count stays 0 and cleared by any old phone, so "no old phone for N days" is one comparison. Rows that
-- report none today start their wait at their last report: nothing earlier was recorded.
ALTER TABLE relay_adoption ADD COLUMN legacy_clear_at INTEGER;

UPDATE relay_adoption SET legacy_clear_at = updated_at WHERE legacy_devices = 0;

-- What one full pass of the idle scan would reclaim at OMB_TUNNEL_RECLAIM_PREVIEW_DAYS, per account. Counts and
-- timestamps only. `running` is the pass under way (NULL between passes, and for a pass joined part-way);
-- `eligible` the last finished pass (NULL until one finishes at these `days`).
CREATE TABLE managed_endpoint_reclaim_preview (
  provider_account TEXT PRIMARY KEY CHECK (length(provider_account) = 32),
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 365),
  running INTEGER CHECK (running IS NULL OR running >= 0),
  eligible INTEGER CHECK (eligible IS NULL OR eligible >= 0),
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
