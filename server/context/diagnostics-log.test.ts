// The event has to survive the canonical NDJSON log, not just the type
// system. The reader validates unknown JSON at runtime and its switch ends
// in `default: return false`, so a new event type that nobody adds a case
// for is silently dropped on read-back — and the compiler cannot see it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readThreadEvents } from "../thread-events.ts";

let dir = "";
const THREAD = "t1";

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventId: "e1",
    provider: "claude",
    threadId: THREAD,
    createdAt: "2026-09-03T00:00:00.000Z",
    type: "context.prepared",
    ownership: "vendor-session",
    mode: "resume-preferred",
    sourceItems: 12,
    sentItems: 12,
    estimatedInputTokens: 900,
    historyTokens: 180_000,
    contextWindow: 200_000,
    limitsSource: "pattern",
    compacted: false,
    clipped: false,
    ...over,
  });

const read = (...lines: string[]) => {
  writeFileSync(join(dir, `${THREAD}.ndjson`), lines.join("\n") + "\n", { mode: 0o600 });
  return readThreadEvents({ threadId: THREAD, eventsDir: dir, nativeDir: dir, limit: 50 });
};

describe("context.prepared survives the canonical log", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-events-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a well-formed event", () => {
    const page = read(line());
    const entry = page.entries.find((e) => e.kind === "runtime");
    expect(entry).toBeDefined();
    expect((entry!.data as { type: string }).type).toBe("context.prepared");
    expect((entry!.data as { contextWindow: number }).contextWindow).toBe(200_000);
  });

  it("rejects a hand-edited line with a bogus count", () => {
    // the log is an ordinary file: people truncate and hand-assemble it
    for (const bad of [-1, 1.5, Number.NaN, "12", null]) {
      expect(read(line({ sentItems: bad })).entries.filter((e) => e.kind === "runtime")).toHaveLength(0);
    }
  });

  it("rejects an ownership or limitsSource outside its union", () => {
    expect(read(line({ ownership: "something-else" })).entries.filter((e) => e.kind === "runtime")).toHaveLength(0);
    expect(read(line({ limitsSource: "guessed" })).entries.filter((e) => e.kind === "runtime")).toHaveLength(0);
  });

  it("rejects a missing boolean rather than defaulting it", () => {
    expect(read(line({ clipped: undefined })).entries.filter((e) => e.kind === "runtime")).toHaveLength(0);
  });

  it("drops only the bad line, keeping good events around it", () => {
    const page = read(line({ eventId: "good-1" }), line({ sentItems: -5 }), line({ eventId: "good-2" }));
    const ids = page.entries.filter((e) => e.kind === "runtime").map((e) => (e.data as { eventId: string }).eventId);
    expect(ids).toEqual(["good-1", "good-2"]);
  });
});
