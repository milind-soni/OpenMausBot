import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOM_FEED_SINCE_FILE, roomFeedSince } from "./room-feed-since.ts";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "omb-feed-since-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("when this place first had the room feed", () => {
  it("is written on first ask and kept", () => {
    const dir = fresh();
    expect(roomFeedSince(dir, 5_000)).toBe(5_000);
    expect(JSON.parse(readFileSync(join(dir, ROOM_FEED_SINCE_FILE), "utf8"))).toEqual({ version: 1, since: 5_000 });
    expect(roomFeedSince(dir, 9_000)).toBe(5_000);
  });

  it("reads a stamp an earlier run wrote, and replaces an unreadable one", () => {
    const kept = fresh();
    writeFileSync(join(kept, ROOM_FEED_SINCE_FILE), JSON.stringify({ version: 1, since: 1_234 }));
    expect(roomFeedSince(kept, 9_000)).toBe(1_234);
    const broken = fresh();
    writeFileSync(join(broken, ROOM_FEED_SINCE_FILE), "{");
    expect(roomFeedSince(broken, 7_000)).toBe(7_000);
  });
});
