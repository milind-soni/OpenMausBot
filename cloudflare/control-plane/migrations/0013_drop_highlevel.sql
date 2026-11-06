-- Drops the HighLevel OAuth relay's tables from 0009 and 0010, with any
-- sealed token payload still in them; nothing references them. IF EXISTS
-- keeps it safe where they were dropped by hand. Apply it after deploying a
-- Worker without the relay: an older Worker still reads and sweeps them.
DROP INDEX IF EXISTS highlevel_flows_created_idx;
DROP INDEX IF EXISTS highlevel_ip_rate_limits_updated_idx;
DROP TABLE IF EXISTS highlevel_flows;
DROP TABLE IF EXISTS highlevel_ip_rate_limits;
