// Retention for per-thread event logs (#1280): only the NDJSON logs of
// threads idle — closed or archived — longer than the window are removed,
// and busy/unread/handoff threads are never touched.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadLogRetentionCandidate } from "./thread-retention.ts";

let home: string;

async function freshSweep() {
  home = mkdtempSync(join(tmpdir(), "omb-retention-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  await import("./config.ts");
  return import("./thread-retention.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-01-31T12:00:00Z");

function candidate(overrides: Partial<ThreadLogRetentionCandidate> & { threadId: string }): ThreadLogRetentionCandidate {
  return { closedAt: null, archivedAt: null, unread: false, busy: false, openDirectHandoff: false, ...overrides };
}

async function writeLogs(threadId: string) {
  const { EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
  for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${threadId}.ndjson`), "{}\n");
  }
}

async function logsExist(threadId: string) {
  const { EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
  return [EVENTS_DIR, NATIVE_DIR].every((dir) => existsSync(join(dir, `${threadId}.ndjson`)));
}

describe("thread event log retention", () => {
  it("removes logs only for threads closed longer than the window", async () => {
    const { sweepThreadEventLogs } = await freshSweep();
    const cases = [
      candidate({ threadId: "old", closedAt: now - 31 * DAY_MS }),
      candidate({ threadId: "recent", closedAt: now - 29 * DAY_MS }),
      candidate({ threadId: "undated" }),
    ];
    for (const each of cases) await writeLogs(each.threadId);

    expect(sweepThreadEventLogs(cases, 30, now)).toBe(1);
    expect(await logsExist("old")).toBe(false);
    expect(await logsExist("recent")).toBe(true);
    expect(await logsExist("undated")).toBe(true);
  });

  it("honors archive stamps and re-closing resets the clock", async () => {
    const { sweepThreadEventLogs } = await freshSweep();
    const cases = [
      candidate({ threadId: "archived-old", archivedAt: now - 40 * DAY_MS }),
      candidate({ threadId: "reclosed", closedAt: now - 40 * DAY_MS, archivedAt: now - DAY_MS }),
    ];
    for (const each of cases) await writeLogs(each.threadId);

    expect(sweepThreadEventLogs(cases, 30, now)).toBe(1);
    expect(await logsExist("archived-old")).toBe(false);
    expect(await logsExist("reclosed")).toBe(true);
  });

  it("keeps a thread whose newest stamp lands exactly on the cutoff", async () => {
    const { sweepThreadEventLogs } = await freshSweep();
    const exact = candidate({ threadId: "exact", closedAt: now - 30 * DAY_MS });
    await writeLogs("exact");

    expect(sweepThreadEventLogs([exact], 30, now)).toBe(0);
    expect(await logsExist("exact")).toBe(true);
  });

  it("never touches busy, unread, or handoff-carrying threads", async () => {
    const { sweepThreadEventLogs } = await freshSweep();
    const cases = [
      candidate({ threadId: "busy", closedAt: now - 40 * DAY_MS, busy: true }),
      candidate({ threadId: "unread", closedAt: now - 40 * DAY_MS, unread: true }),
      candidate({ threadId: "handoff", closedAt: now - 40 * DAY_MS, openDirectHandoff: true }),
    ];
    for (const each of cases) await writeLogs(each.threadId);

    expect(sweepThreadEventLogs(cases, 30, now)).toBe(0);
    for (const each of cases) expect(await logsExist(each.threadId)).toBe(true);
  });

  it("counts a swept thread once and tolerates missing files", async () => {
    const { sweepThreadEventLogs } = await freshSweep();
    const old = candidate({ threadId: "old", closedAt: now - 31 * DAY_MS });
    await writeLogs("old");

    expect(sweepThreadEventLogs([old], 30, now)).toBe(1);
    // the files are gone, so a repeat sweep has nothing to do
    expect(sweepThreadEventLogs([old], 30, now)).toBe(0);
  });

  it("warns on removal failures other than a missing file", async () => {
    const { sweepThreadEventLogs } = await freshSweep();
    const { EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
    const blocked = candidate({ threadId: "blocked", closedAt: now - 31 * DAY_MS });
    const halfBlocked = candidate({ threadId: "half-blocked", closedAt: now - 31 * DAY_MS });
    const missing = candidate({ threadId: "missing", closedAt: now - 31 * DAY_MS });
    await writeLogs("blocked");
    await writeLogs("half-blocked");
    // a directory where a log file belongs makes unlink fail without ENOENT
    rmSync(join(EVENTS_DIR, "blocked.ndjson"));
    rmSync(join(NATIVE_DIR, "blocked.ndjson"));
    mkdirSync(join(EVENTS_DIR, "blocked.ndjson"));
    mkdirSync(join(NATIVE_DIR, "blocked.ndjson"));
    rmSync(join(EVENTS_DIR, "half-blocked.ndjson"));
    mkdirSync(join(EVENTS_DIR, "half-blocked.ndjson"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(sweepThreadEventLogs([blocked, halfBlocked, missing], 30, now)).toBe(1);
    // half-blocked still lost its native/ log, so only that thread counts
    expect(existsSync(join(NATIVE_DIR, "half-blocked.ndjson"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
    const warned = warn.mock.calls[0]!.join(" ");
    expect(warned).toContain("[retention]");
    expect(warned).toContain("blocked.ndjson");
    warn.mockRestore();
  });
});
