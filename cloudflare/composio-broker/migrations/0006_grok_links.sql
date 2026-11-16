-- The Grok Bot link (src/grok-link.ts): one row is one link that is on. key_hash is sha256 of the key in the public
-- address and names the link's Durable Object; neither the key nor the desktop's secret is stored. A link no
-- desktop attached to for 30 days is deleted, and comes back as the same row when that desktop attaches again.
CREATE TABLE grok_links (
  key_hash    TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  attached_at INTEGER NOT NULL
);
CREATE INDEX grok_links_attached ON grok_links (attached_at);
