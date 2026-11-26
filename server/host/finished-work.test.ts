import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, Message, StoreChange, TaskRecord } from "../store.ts";
import { archivedOnResult, archivesOnResult, closesOnResult, createHandedClose, finishHandedThread, opensAgain, reopenHandedThread, STOP_GRACE_MS, stoppedByPerson } from "./finished-work.ts";

type Task = Parameters<typeof closesOnResult>[0];
const opened = (more: Partial<NonNullable<TaskRecord["openedBy"]>> = {}): NonNullable<TaskRecord["openedBy"]> =>
  ({ botId: "chief", name: "Clive", threadId: "chief-chat", at: 0, ...more });
/** A thread coordinate_bots opened with thread "new" for one hand-off. */
const oneShot = (more: Partial<NonNullable<TaskRecord["openedBy"]>> = {}) => opened({ oneShot: true, ...more });
const closes = (task: Task, opener = "chief", owner = "lead") => closesOnResult(task, opener, owner);

describe("closesOnResult", () => {
  it("closes the standing work thread", () => {
    expect(closes({ openedBy: opened({ kind: "work" }) })).toBe(true);
  });

  it("closes a thread a teammate opened with thread \"new\" for one hand-off", () => {
    expect(closes({ openedBy: oneShot() })).toBe(true);
  });

  it("keeps a thread start_thread opened on a teammate, or one a post_to_thread reached", () => {
    expect(closes({ openedBy: opened() })).toBe(false);
  });

  it("keeps a thread \"new\" opened that was pinned or filed in a folder", () => {
    expect(closes({ openedBy: oneShot(), pinned: true })).toBe(false);
    expect(closes({ openedBy: oneShot(), projectId: "folder-1" })).toBe(false);
  });

  it("closes a thread \"new\" opened that the person wrote in during the work", () => {
    expect(closes({ openedBy: oneShot(), askedAt: 1 } as Task)).toBe(true);
  });

  it("closes the standing work thread whether or not it was kept", () => {
    expect(closes({ openedBy: opened({ kind: "work" }), pinned: true, projectId: "folder-1" })).toBe(true);
  });

  it("keeps the pair conversation, a burst's part, a room lane and a thread a bot opened on itself", () => {
    expect(closes({ openedBy: oneShot({ kind: "pair" }) })).toBe(false);
    expect(closes({ openedBy: oneShot({ burstId: "burst-1" }) })).toBe(false);
    expect(closes({ openedBy: oneShot({ roomLane: true }) })).toBe(false);
    expect(closes({ openedBy: oneShot({ botId: "lead" }) }, "lead", "lead")).toBe(false);
  });

  it("leaves a thread another bot opened, one already closed, and one nobody opened", () => {
    expect(closes({ openedBy: oneShot({ botId: "other" }) })).toBe(false);
    expect(closes({ openedBy: opened({ kind: "work", botId: "other" }) })).toBe(false);
    expect(closes({ openedBy: oneShot(), closedBy: { botId: "chief", name: "Clive", at: 1 } })).toBe(false);
    expect(closes({})).toBe(false);
    expect(closes(undefined)).toBe(false);
  });
});

describe("archivesOnResult", () => {
  it("archives a one-shot thread, but not the standing work thread or a thread start_thread opened", () => {
    expect(archivesOnResult({ openedBy: oneShot() }, false)).toBe(true);
    expect(archivesOnResult({ openedBy: opened({ kind: "work" }) }, false)).toBe(false);
    expect(archivesOnResult({ openedBy: opened() }, false)).toBe(false);
  });

  it("leaves an unread thread in the sidebar", () => {
    expect(archivesOnResult({ openedBy: oneShot(), unread: true }, false)).toBe(false);
  });

  it("leaves a thread whose wait is still armed in the sidebar", () => {
    expect(archivesOnResult({ openedBy: oneShot() }, true)).toBe(false);
  });

  it("leaves a thread whose bot asks the person something in the sidebar", () => {
    expect(archivesOnResult({ openedBy: oneShot(), activity: "waiting-on-you" }, false)).toBe(false);
  });
});

describe("finishHandedThread", () => {
  const fakeStore = (task: Partial<TaskRecord>) => {
    const record = { threadId: "lead-thread", ...task } as TaskRecord;
    const calls: string[] = [];
    return {
      record, calls,
      taskByThread: (_botId: string, threadId: string) => threadId === record.threadId ? record : undefined,
      bot: (botId: string) => (botId === "chief" ? { name: "Clive" } : undefined) as never,
      setTaskClosedBy: (_botId: string, _threadId: string, closedBy: TaskRecord["closedBy"] | null) => { record.closedBy = closedBy ?? undefined; calls.push("closed"); return record; },
      patchTask: (_botId: string, _threadId: string, patch: Partial<TaskRecord>) => { Object.assign(record, patch); calls.push(`archivedAt=${patch.archivedAt}`); return record; },
    };
  };

  it("closes and archives a one-shot thread at the same moment", () => {
    const store = fakeStore({ openedBy: oneShot() });
    finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
    expect(store.record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 42 });
    expect(store.record.archivedAt).toBe(42);
  });

  it("only closes the standing work thread and an unread thread", () => {
    for (const task of [{ openedBy: opened({ kind: "work" }) }, { openedBy: oneShot(), unread: true }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
      expect(store.calls).toEqual(["closed"]);
    }
  });

  it("neither closes nor archives a thread that stays open", () => {
    for (const task of [{ openedBy: oneShot(), pinned: true }, { openedBy: oneShot({ kind: "pair" as const }) }, { openedBy: opened() }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
      expect(store.calls).toEqual([]);
    }
  });
});

describe("reopenHandedThread", () => {
  const closedBy = { botId: "chief", name: "Clive", at: 5 };
  it("takes a one-shot thread out of the archive its result put it in", () => {
    const patches: unknown[] = [];
    const store = { patchTask: (_botId: string, _threadId: string, patch: unknown) => { patches.push(patch); return null; } };
    reopenHandedThread(store, "lead", { threadId: "t", openedBy: oneShot(), closedBy, archivedAt: 5 });
    reopenHandedThread(store, "lead", { threadId: "t", openedBy: oneShot() });
    expect(patches).toEqual([{ archivedAt: undefined }]);
  });

  it("leaves a thread the person archived in the archive", () => {
    expect(archivedOnResult({ openedBy: oneShot(), closedBy, archivedAt: 5 })).toBe(true);
    expect(archivedOnResult({ openedBy: oneShot(), closedBy, archivedAt: 8 })).toBe(false);
    expect(archivedOnResult({ openedBy: oneShot(), archivedAt: 5 })).toBe(false);
    expect(archivedOnResult({ openedBy: oneShot(), closedBy: { ...closedBy, botId: "lead" }, archivedAt: 5 })).toBe(false);
    expect(archivedOnResult({ openedBy: opened(), closedBy, archivedAt: 5 })).toBe(false);
  });
});


describe("stoppedByPerson", () => {
  const ended = (more: Partial<HandoffView>) => ({ status: "cancelled" as const, outcome: "stopped" as const, ...more });
  it("is the person's Stop in the thread, or in the conversation that handed the work on", () => {
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped by user" }))).toBe(true);
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped with the request it was for" }), { outcomeDetail: "Stopped by user" })).toBe(true);
  });

  it("is not a stop its requester or the system made, nor a failure", () => {
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped by @Clive, who handed this work on" }))).toBe(false);
    expect(stoppedByPerson(ended({ outcomeDetail: "The source conversation was deleted" }))).toBe(false);
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped with the request it was for" }), { outcomeDetail: "The routine restarted" })).toBe(false);
    expect(stoppedByPerson({ status: "failed", outcome: "stalled", outcomeDetail: "Stopped by user" })).toBe(false);
  });
});

describe("opensAgain", () => {
  it("is the person writing, a bot's post, or new work handed there; not the lines a run leaves", () => {
    expect(opensAgain({ role: "user" })).toBe(true);
    expect(opensAgain({ role: "bot", threadPost: { deliveryId: "d", fromBotId: "chief", fromThreadId: "chief-chat" } })).toBe(true);
    expect(opensAgain({ role: "bot", roomRequest: { id: "h", phase: "request" } })).toBe(true);
    expect(opensAgain({ role: "bot", roomRequest: { id: "h", phase: "result" } })).toBe(false);
    expect(opensAgain({ role: "bot" })).toBe(false);
  });
});

describe("createHandedClose", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  /** One saved thread of "lead" that "chief" handed work to; `records` is what survives a restart. */
  const world = (task: Partial<TaskRecord>, live = { working: false, waitArmed: false }) => {
    const record = { threadId: "lead-thread", title: "Work", ...task } as TaskRecord;
    const bots = [{ id: "lead", name: "Lee", tasks: [record] }] as unknown as BotRecord[];
    const listeners = new Set<(change: StoreChange) => void>();
    const store = {
      bots,
      bot: (botId: string) => (botId === "chief" ? { name: "Clive" } : undefined) as never,
      botByThread: (threadId: string) => (threadId === record.threadId ? bots[0] : undefined) as never,
      taskByThread: (_botId: string, threadId: string) => threadId === record.threadId ? record : undefined,
      setTaskClosedBy: (_botId: string, _threadId: string, closedBy: TaskRecord["closedBy"] | null) => { record.closedBy = closedBy ?? undefined; return record; },
      setTaskOpenedBy: (_botId: string, _threadId: string, openedBy: TaskRecord["openedBy"]) => { record.openedBy = openedBy; return record; },
      patchTask: (_botId: string, _threadId: string, patch: Partial<TaskRecord>) => { Object.assign(record, patch); return record; },
      onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const start = () => createHandedClose({ store, working: () => live.working, waitArmed: () => live.waitArmed });
    const write = (message: Partial<Message>) => { for (const listener of listeners) listener({ type: "message", threadId: record.threadId, message: message as Message }); };
    return { record, live, start, write };
  };
  const chief = { id: "chief-node", botId: "chief", threadId: "chief-chat" } as HandoffView;
  const work = (more: Partial<HandoffView>) => ({ id: "h1", parentId: "chief-node", botId: "lead", threadId: "lead-thread", status: "completed", ...more }) as HandoffView;
  const personStop = work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped by user" });

  it("closes and archives a one-shot thread when its work is done, failed, or stopped by the bot that handed it on", () => {
    for (const ended of [work({}), work({ status: "failed", outcome: "provider_error" }), work({ status: "failed", outcome: "stalled" }),
      work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped by @Clive, who handed this work on" })]) {
      const { record, start } = world({ openedBy: oneShot() });
      start().ended(ended, chief, false);
      expect(record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 1_000_000 });
      expect(record.archivedAt).toBe(1_000_000);
    }
  });

  it("only closes the standing work thread when its work fails", () => {
    const { record, start } = world({ openedBy: opened({ kind: "work" }) });
    start().ended(work({ status: "failed", outcome: "provider_error" }), chief, false);
    expect(record.closedBy?.botId).toBe("chief");
    expect(record.archivedAt).toBeUndefined();
  });

  it("leaves a thread open while work there is still live, and a done result its requester could not take", () => {
    const busy = world({ openedBy: oneShot() }, { working: true, waitArmed: false });
    busy.start().ended(work({ status: "failed", outcome: "provider_error" }), chief, false);
    expect(busy.record.closedBy).toBeUndefined();
    const withheld = world({ openedBy: oneShot() });
    withheld.start().ended(work({}), chief, true);
    expect(withheld.record.closedBy).toBeUndefined();
  });

  it("closes a one-shot thread a bot posted into and the person wrote in during the work", () => {
    const { record, start, write } = world({ openedBy: oneShot(), askedAt: 5 });
    const close = start();
    write({ role: "bot", threadPost: { deliveryId: "d", fromBotId: "chief", fromThreadId: "chief-chat" } });
    write({ role: "user" });
    close.ended(work({}), chief, false);
    expect(record.openedBy?.oneShot).toBe(true);
    expect(record.archivedAt).toBe(1_000_000);
  });

  it("keeps a thread the person stopped open for an hour, then closes and archives it", () => {
    const { record, start } = world({ openedBy: oneShot() });
    start().ended(personStop, chief, false);
    expect(record.closedBy).toBeUndefined();
    expect(record.openedBy?.closesAt).toBe(1_000_000 + STOP_GRACE_MS);
    vi.advanceTimersByTime(STOP_GRACE_MS - 1);
    expect(record.closedBy).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 1_000_000 + STOP_GRACE_MS });
    expect(record.archivedAt).toBe(1_000_000 + STOP_GRACE_MS);
    expect(record.openedBy).toEqual(oneShot());
  });

  it("waits the hour too when the person stopped the conversation that handed the work on", () => {
    const { record, start } = world({ openedBy: oneShot() });
    start().ended(work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped with the request it was for" }), { ...chief, outcomeDetail: "Stopped by user" }, false);
    expect(record.closedBy).toBeUndefined();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(record.archivedAt).toBe(1_000_000 + STOP_GRACE_MS);
  });

  it("keeps a stopped thread open for good when anyone writes in it within the hour", () => {
    for (const message of [{ role: "user" as const }, { role: "bot" as const, threadPost: { deliveryId: "d", fromBotId: "chief", fromThreadId: "chief-chat" } }]) {
      const { record, start, write } = world({ openedBy: oneShot() });
      start().ended(personStop, chief, false);
      vi.advanceTimersByTime(30 * 60_000);
      write(message);
      expect(record.openedBy?.closesAt).toBeUndefined();
      vi.advanceTimersByTime(2 * STOP_GRACE_MS);
      expect(record.closedBy).toBeUndefined();
      expect(record.archivedAt).toBeUndefined();
    }
  });

  it("closes a stopped thread on time after a restart, from the deadline it saved", () => {
    const { record, start } = world({ openedBy: oneShot() });
    const before = start();
    before.ended(personStop, chief, false);
    before.dispose();
    vi.advanceTimersByTime(40 * 60_000);
    start();
    vi.advanceTimersByTime(20 * 60_000 - 1);
    expect(record.closedBy).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(record.archivedAt).toBe(1_000_000 + STOP_GRACE_MS);
  });

  it("closes at once on restart a stopped thread whose hour passed while the server was down", () => {
    const { record, start } = world({ openedBy: oneShot({ closesAt: 1_000_000 - 1 }) });
    start();
    vi.advanceTimersByTime(0);
    expect(record.archivedAt).toBe(1_000_000);
  });

  it("at the hour, leaves open a stopped thread a bot works in, and in the sidebar one that waits on the person", () => {
    const busy = world({ openedBy: oneShot() });
    busy.start().ended(personStop, chief, false);
    busy.live.working = true;
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(busy.record.closedBy).toBeUndefined();
    expect(busy.record.openedBy?.closesAt).toBeUndefined();
    for (const [task, live] of [[{ unread: true }, { working: false, waitArmed: false }], [{ activity: "waiting-on-you" as const }, { working: false, waitArmed: false }],
      [{}, { working: false, waitArmed: true }]] as const) {
      const waiting = world({ openedBy: oneShot(), ...task }, { ...live });
      waiting.start().ended(personStop, chief, false);
      vi.advanceTimersByTime(STOP_GRACE_MS);
      expect(waiting.record.closedBy?.botId).toBe("chief");
      expect(waiting.record.archivedAt).toBeUndefined();
    }
  });

  it("takes a closed one-shot thread out of the archive on a new message, not on the lines a run leaves", () => {
    const { record, start, write } = world({ openedBy: oneShot() });
    start().ended(work({}), chief, false);
    write({ role: "bot", kind: "activity" });
    expect(record.archivedAt).toBe(1_000_000);
    write({ role: "bot", threadPost: { deliveryId: "d", fromBotId: "chief", fromThreadId: "chief-chat" } });
    expect(record.archivedAt).toBeUndefined();
  });

  it("never closes a thread the person started, or one start_thread opened, however its work ends", () => {
    for (const task of [{}, { openedBy: opened() }]) {
      for (const ended of [work({}), work({ status: "failed", outcome: "provider_error" }), personStop]) {
        const { record, start } = world(task);
        start().ended(ended, chief, false);
        vi.advanceTimersByTime(STOP_GRACE_MS);
        expect(record.closedBy).toBeUndefined();
        expect(record.archivedAt).toBeUndefined();
        expect(record.openedBy?.closesAt).toBeUndefined();
      }
    }
  });

  it("leaves a room's work alone", () => {
    const { record, start } = world({ openedBy: oneShot() });
    start().ended(work({ status: "failed", outcome: "provider_error", groupId: "room-1" }), chief, false);
    expect(record.closedBy).toBeUndefined();
  });
});
