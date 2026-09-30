// Optional auto-archive of long-closed threads (#1280): the selector
// picks only closed, idle, unarchived threads past the window; the archive
// itself rides store.patchTask so the durable context survives (#1194).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectiveAutoArchiveDays,
  selectAutoArchiveThreads,
  type AutoArchiveCandidate,
} from "./thread-auto-archive.ts";

let home: string | undefined;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-auto-archive-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })) };
}

afterEach(async () => {
  if (home) {
    const { closeMessageDb } = await import("./message-db.ts");
    closeMessageDb();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    home = undefined;
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-01-31T12:00:00Z");

function candidate(overrides: Partial<AutoArchiveCandidate> & { threadId: string }): AutoArchiveCandidate {
  return {
    autoArchiveDays: 30,
    closedAt: now - 31 * DAY_MS,
    archivedAt: null,
    restoredAt: null,
    unread: false,
    busy: false,
    snoozed: false,
    pinned: false,
    hasQueuedWork: false,
    peerConversation: false,
    openDirectHandoff: false,
    ...overrides,
  };
}

describe("auto-archive window resolution", () => {
  it("keeps auto-archive off unless a window is set, with the bot override winning", () => {
    expect(effectiveAutoArchiveDays(null, undefined)).toBeNull();
    expect(effectiveAutoArchiveDays(30, undefined)).toBe(30);
    expect(effectiveAutoArchiveDays(30, 7)).toBe(7);
    // 0 is the per-bot opt-out, even when the global window is on
    expect(effectiveAutoArchiveDays(30, 0)).toBeNull();
    // a bot can opt in when the global setting is off
    expect(effectiveAutoArchiveDays(null, 7)).toBe(7);
  });
});

describe("auto-archive selection", () => {
  it("selects only threads closed longer than the window", () => {
    const cases = [
      candidate({ threadId: "old" }),
      candidate({ threadId: "recent", closedAt: now - 29 * DAY_MS }),
      candidate({ threadId: "open", closedAt: null }),
    ];
    expect(selectAutoArchiveThreads(cases, now)).toEqual(["old"]);
  });

  it("keeps a thread whose close lands exactly on the cutoff", () => {
    expect(selectAutoArchiveThreads([candidate({ threadId: "exact", closedAt: now - 30 * DAY_MS })], now)).toEqual([]);
  });

  it("never selects busy, unread, snoozed, pinned, queued, or handoff-carrying threads", () => {
    const cases = [
      candidate({ threadId: "busy", busy: true }),
      candidate({ threadId: "unread", unread: true }),
      candidate({ threadId: "snoozed-until-activity", snoozed: true }),
      candidate({ threadId: "snoozed-with-wake-time", snoozed: true, closedAt: now - 40 * DAY_MS }),
      candidate({ threadId: "pinned", pinned: true }),
      candidate({ threadId: "queued-work", hasQueuedWork: true }),
      candidate({ threadId: "handoff", openDirectHandoff: true }),
    ];
    expect(selectAutoArchiveThreads(cases, now)).toEqual([]);
  });

  it("never selects a standing peer pair conversation; a finished peer work row stays eligible", () => {
    // The pair row is the durable conversation resolvePairConversation
    // reuses when the peer writes again — archiving it would hide the
    // reopened thread. The one-off "work" rows have no such reuse.
    expect(selectAutoArchiveThreads([
      candidate({ threadId: "pair-row", peerConversation: true }),
      candidate({ threadId: "work-row" }),
    ], now)).toEqual(["work-row"]);
  });

  it("exempts a thread restored after its close until it is closed again", () => {
    // Restored 1 day ago; closed 31 days ago. The restore is newer than the
    // close that would have archived it, so the sweep leaves it alone.
    expect(selectAutoArchiveThreads([candidate({ threadId: "restored", restoredAt: now - DAY_MS })], now)).toEqual([]);
    // Closed again 31 days ago... after a still-earlier restore: the newest
    // close re-arms the window, so the thread is selected once past it.
    expect(selectAutoArchiveThreads([candidate({
      threadId: "re-closed", closedAt: now - 31 * DAY_MS, restoredAt: now - 32 * DAY_MS,
    })], now)).toEqual(["re-closed"]);
    // A restore older than the window-plus-close changes nothing: only the
    // ordering of restore vs close matters, then the close's own clock.
    expect(selectAutoArchiveThreads([candidate({
      threadId: "stale-restore", closedAt: now - 31 * DAY_MS, restoredAt: now - 60 * DAY_MS,
    })], now)).toEqual(["stale-restore"]);
  });

  it("never re-archives a thread and skips bots whose window resolved off", () => {
    const cases = [
      candidate({ threadId: "archived", archivedAt: now - DAY_MS }),
      candidate({ threadId: "off", autoArchiveDays: 0 }),
    ];
    expect(selectAutoArchiveThreads(cases, now)).toEqual([]);
  });
});

describe("auto-archive through the store", () => {
  it("archives via patchTask and preserves the thread's durable context (#1194)", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    const closedAt = now - 31 * DAY_MS;
    store.setResumeCursor(bot.id, "claude", "cursor-1", task.threadId);
    store.patchTask(bot.id, task.threadId, { lastInstanceId: "claude", cwd: "/tmp/project" });
    store.setTaskClosedBy(bot.id, task.threadId, { botId: bot.id, name: bot.name, at: closedAt });

    const candidateFrom = (threadId: string): AutoArchiveCandidate => {
      const record = store.taskByThread(bot.id, threadId)!;
      return {
        threadId,
        autoArchiveDays: 30,
        closedAt: record.closedBy?.at ?? null,
        archivedAt: record.archivedAt ?? null,
        restoredAt: record.restoredAt ?? null,
        unread: record.unread === true,
        busy: false,
        snoozed: false,
        pinned: false,
        hasQueuedWork: false,
        peerConversation: record.openedBy?.kind === "pair",
        openDirectHandoff: false,
      };
    };
    expect(selectAutoArchiveThreads([candidateFrom(task.threadId)], now)).toEqual([task.threadId]);

    store.patchTask(bot.id, task.threadId, { archivedAt: now });
    const archived = store.taskByThread(bot.id, task.threadId)!;
    expect(archived.archivedAt).toBe(now);
    expect(archived.resumeCursors.claude).toBe("cursor-1");
    expect(archived.lastInstanceId).toBe("claude");
    expect(archived.cwd).toBe("/tmp/project");
    expect(archived.closedBy?.at).toBe(closedAt);
    // idempotent: the archived thread is not picked again
    expect(selectAutoArchiveThreads([candidateFrom(task.threadId)], now)).toEqual([]);
  });

  it("stamps a restore so the next sweep does not archive the thread again (#1286 hold)", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    const closedAt = now - 40 * DAY_MS;
    store.setTaskClosedBy(bot.id, task.threadId, { botId: bot.id, name: bot.name, at: closedAt });
    // Unarchiving a thread that was never archived is not a restore.
    store.patchTask(bot.id, task.threadId, { archivedAt: undefined });
    expect(store.taskByThread(bot.id, task.threadId)?.restoredAt).toBeUndefined();

    store.patchTask(bot.id, task.threadId, { archivedAt: now - 5 * DAY_MS });
    store.patchTask(bot.id, task.threadId, { archivedAt: undefined });
    const restored = store.taskByThread(bot.id, task.threadId)!;
    // closedBy.at survives the restore verbatim — the exemption is carried
    // by restoredAt, not by rewriting who closed the thread when.
    expect(restored.closedBy?.at).toBe(closedAt);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.restoredAt).toBeGreaterThan(now);
    const record = store.taskByThread(bot.id, task.threadId)!;
    expect(selectAutoArchiveThreads([{
      threadId: task.threadId,
      autoArchiveDays: 30,
      closedAt: record.closedBy?.at ?? null,
      archivedAt: record.archivedAt ?? null,
      restoredAt: record.restoredAt ?? null,
      unread: record.unread === true,
      busy: false,
      snoozed: false,
      pinned: false,
      hasQueuedWork: false,
      peerConversation: record.openedBy?.kind === "pair",
      openDirectHandoff: false,
    }], Date.now())).toEqual([]);
  });
});
