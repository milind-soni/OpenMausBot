-- MausBot Relay usage per UTC day, as counts only: how many installations asked for a relay token, got one, reported
-- end-to-end phones, or asked for the first time. A row is (day, kind, installs); no installation id, device or
-- address is kept in it. The three timestamps on relay_adoption let a request tell whether its installation was
-- already counted today.
ALTER TABLE relay_adoption ADD COLUMN first_seen_at INTEGER;
ALTER TABLE relay_adoption ADD COLUMN token_at INTEGER;
ALTER TABLE relay_adoption ADD COLUMN e2e_at INTEGER;

-- Rows from before this migration: first seen at their last request (0012 kept no earlier time), and counted below on
-- that day, so a request later the same day is not counted twice. Which of them got a token was never recorded.
UPDATE relay_adoption
   SET first_seen_at = updated_at,
       e2e_at = CASE WHEN e2e_devices > 0 THEN updated_at END;

CREATE TABLE relay_daily (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('seen', 'token', 'e2e', 'new')),
  installs INTEGER NOT NULL CHECK (installs >= 0),
  PRIMARY KEY (day, kind)
) WITHOUT ROWID;

INSERT INTO relay_daily (day, kind, installs)
  SELECT strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch'), 'seen', COUNT(*) FROM relay_adoption GROUP BY 1;
INSERT INTO relay_daily (day, kind, installs)
  SELECT strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch'), 'new', COUNT(*) FROM relay_adoption GROUP BY 1;
INSERT INTO relay_daily (day, kind, installs)
  SELECT strftime('%Y-%m-%d', e2e_at / 1000, 'unixepoch'), 'e2e', COUNT(*) FROM relay_adoption WHERE e2e_at IS NOT NULL GROUP BY 1;
