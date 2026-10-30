-- When a browser callback took the flow to end it or exchange its code.
-- HighLevel's code is single-use, so only that callback may fill or delete
-- the row: a second callback with the same state is refused.
ALTER TABLE highlevel_flows ADD COLUMN callback_at INTEGER;
