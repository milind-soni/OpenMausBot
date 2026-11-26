// `room-feed-since.json` in the data folder: when this place first ran with the room feed for everyone. A room thread
// whose unread mark is older than that was marked under the single transcript, where only the thread on screen was
// ever read; the feed reads such marks once (src/lib/room-feed.ts), so they do not stay unread for good.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export const ROOM_FEED_SINCE_FILE = "room-feed-since.json";

const known = new Map<string, number>();

/** The stamp, written the first time it is asked for. A file that can't be read or written leaves the stamp at now,
 * which only spares fewer old marks. */
export function roomFeedSince(dataDir: string, now = Date.now()): number {
  const cached = known.get(dataDir);
  if (cached !== undefined) return cached;
  const file = join(dataDir, ROOM_FEED_SINCE_FILE);
  let since: number | null = null;
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as { since?: unknown }).since;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) since = value;
  } catch { /* missing or unreadable: first run */ }
  if (since === null) {
    since = now;
    try { writeFileAtomic(file, JSON.stringify({ version: 1, since }), { mode: 0o600 }); } catch { /* kept in memory */ }
  }
  known.set(dataDir, since);
  return since;
}
