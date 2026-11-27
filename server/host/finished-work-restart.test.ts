import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { HandoffView } from "../coordinator.ts";
import { closeMessageDb } from "../message-db.ts";
import { flushLaterSaves } from "../save-batch.ts";
import { Store } from "../store.ts";
import { createHandedClose, STOP_GRACE_MS } from "./finished-work.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("a stopped hand-off thread across a restart", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    flushLaterSaves();
    closeMessageDb();
    vi.useRealTimers();
  });

  it("closes on time from the deadline bots.json holds, in a server that starts from that file", () => {
    const before = new Store(selection);
    const chief = before.createBot({ name: "Clive" }, { seedMessages: false });
    const lead = before.createBot({ name: "Lee" }, { seedMessages: false });
    const thread = before.createTask(lead.id, "Work", false, undefined, { botId: chief.id, name: "Clive", threadId: chief.threadId, at: 0, oneShot: true })!;
    const deps = { working: () => false, waitArmed: () => false };
    const running = createHandedClose({ store: before, ...deps });
    vi.advanceTimersByTime(0);
    running.ended({ id: "h1", parentId: "p", botId: lead.id, threadId: thread.threadId, status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped by user" } as HandoffView,
      { id: "p", botId: chief.id, threadId: chief.threadId } as HandoffView, false);
    running.dispose();
    flushLaterSaves();

    vi.advanceTimersByTime(40 * 60_000);
    const after = new Store(selection);
    expect(after.taskByThread(lead.id, thread.threadId)?.openedBy?.closesAt).toBe(1_000_000 + STOP_GRACE_MS);
    createHandedClose({ store: after, ...deps });
    vi.advanceTimersByTime(20 * 60_000 - 1);
    expect(after.taskByThread(lead.id, thread.threadId)?.archivedAt).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(after.taskByThread(lead.id, thread.threadId)).toMatchObject({ archivedAt: 1_000_000 + STOP_GRACE_MS, closedBy: { botId: chief.id, at: 1_000_000 + STOP_GRACE_MS } });
  });
});
