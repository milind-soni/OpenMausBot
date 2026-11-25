import { describe, expect, it } from "vitest";

import type { TaskRecord } from "../store.ts";
import { OUTSIDE_STAYS_HERE } from "./outside-lineage.ts";
import { besideBusy, workThreadFor } from "./work-thread.ts";

const by = (botId: string, name: string, threadId: string): TaskRecord["openedBy"] => ({ botId, name, threadId, kind: "work", at: 0 });
const task = (threadId: string, openedBy?: TaskRecord["openedBy"], more: Partial<TaskRecord> = {}): TaskRecord =>
  ({ id: threadId, threadId, title: threadId, ...(openedBy ? { openedBy } : {}), ...more }) as TaskRecord;

// Bugfixer's scheduled run ("run-1") asked Liaison with reply none: Liaison's running assignment answers "run-1".
// An earlier run ("run-0") once handed the same reused "liaison-work" thread work, so its opener is stale.
const tasks: Record<string, TaskRecord[]> = {
  bugfixer: [task("run-0"), task("run-1"), task("archived-run", undefined, { archivedAt: 1 }), task("opened-by-liaison", by("liaison", "Liaison", "liaison-chat"))],
  liaison: [task("liaison-work", by("bugfixer", "Bugfixer", "run-0"))],
};
const run1 = { botId: "bugfixer", threadId: "run-1" };
const store = {
  taskByThread: (botId: string, threadId: string) => (tasks[botId] ?? []).find((t) => t.threadId === threadId),
  workThread: () => undefined,
};
const fromLiaison = (thread: string, notice: boolean, also: (task: TaskRecord) => boolean = () => true,
  answering: { botId: string; threadId: string } | undefined = run1) => workThreadFor(store,
  { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-work", thread, notice, answering, also, reach: () => true });

describe("workThreadFor", () => {
  it("keeps a thread the sender opened", () => {
    expect(fromLiaison("opened-by-liaison", false)?.threadId).toBe("opened-by-liaison");
  });

  it("keeps a one-shot thread the sender opened after its result archived it, so a follow-up or rework there reopens it", () => {
    const archived = (more: Partial<TaskRecord>, oneShot = true) => workThreadFor({ ...store, taskByThread: () => task("finished-new",
      { botId: "liaison", name: "Liaison", threadId: "liaison-chat", at: 0, ...(oneShot ? { oneShot: true as const } : {}) }, more) },
    { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread: "finished-new",
      notice: false, answering: undefined, also: () => true, reach: () => true })?.threadId;
    expect(archived({ archivedAt: 9, closedBy: { botId: "liaison", name: "Liaison", at: 9 } })).toBe("finished-new");
    // The person archived it (another moment than the close), or it was never one hand-off's: it stays in the archive.
    expect(() => archived({ archivedAt: 12, closedBy: { botId: "liaison", name: "Liaison", at: 9 } })).toThrow(/is not a thread you opened/);
    expect(() => archived({ archivedAt: 9 })).toThrow(/is not a thread you opened/);
    expect(() => archived({ archivedAt: 9, closedBy: { botId: "liaison", name: "Liaison", at: 9 } }, false)).toThrow(/is not a thread you opened/);
  });

  it("lets a one-way notice answer the thread that handed the sender work, and refuses new work there", () => {
    expect(fromLiaison("run-1", true)?.threadId).toBe("run-1");
    expect(() => fromLiaison("run-1", false)).toThrow(/handed you work: answer it there with reply "none"/);
  });

  it("takes that notice only for the running assignment's requester, not a stale opener of a reused thread", () => {
    expect(() => fromLiaison("run-0", true)).toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => workThreadFor(store, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-work", thread: "run-1",
      notice: true, answering: undefined, also: () => true, reach: () => true })).toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => fromLiaison("run-1", true, () => true, { botId: "someone", threadId: "run-1" })).toThrow(/is not a thread you opened on Bugfixer/);
  });

  it("says in plain words that confined work stays out of a thread it may not reach, opened by the sender or not", () => {
    const reach = () => false;
    expect(() => workThreadFor(store, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread: "opened-by-liaison", notice: false, answering: undefined, also: () => true, reach })).toThrow(OUTSIDE_STAYS_HERE);
    expect(() => workThreadFor(store, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread: "run-1", notice: true, answering: run1, also: () => true, reach })).toThrow(OUTSIDE_STAYS_HERE);
  });

  it("refuses any other thread, an archived one, or one `also` rules out, even for a notice", () => {
    const anyOther = { ...store, taskByThread: () => task("someone-elses") };
    expect(() => workThreadFor(anyOther, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread: "someone-elses", notice: true, answering: run1, also: () => true, reach: () => true }))
      .toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => fromLiaison("archived-run", true, () => true, { botId: "bugfixer", threadId: "archived-run" })).toThrow(/is not a thread you opened/);
    expect(() => fromLiaison("run-1", true, () => false)).toThrow(/is not a thread you opened/);
  });

  it("lets post_to_thread reach any open thread of the bot, not only one the sender opened, but never a closed or archived one", () => {
    const post = (thread: string, more: Partial<TaskRecord> = {}) => workThreadFor({ ...store, taskByThread: () => task(thread, undefined, more) },
      { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread, notice: true, answering: undefined, also: () => true, reach: () => true, any: true });
    expect(post("run-0")?.threadId).toBe("run-0");
    expect(() => post("closed", { closedBy: {} as TaskRecord["closedBy"] })).toThrow(/is not an open thread of Bugfixer/);
    expect(() => post("archived", { archivedAt: 1 })).toThrow(/is not an open thread of Bugfixer/);
    expect(() => workThreadFor({ ...store, taskByThread: () => undefined }, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat",
      thread: "nope", notice: true, answering: undefined, also: () => true, reach: () => true, any: true })).toThrow(/is not an open thread of Bugfixer/);
    expect(() => workThreadFor({ ...store, taskByThread: () => task("x") }, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat",
      thread: "x", notice: true, answering: undefined, also: () => true, reach: () => false, any: true })).toThrow(OUTSIDE_STAYS_HERE);
  });
});

describe("besideBusy", () => {
  // Liaison's chat "liaison-chat" opened two work threads on Bugfixer earlier: "standing" and "spare".
  const opened = [task("standing", by("liaison", "Liaison", "liaison-chat")), task("spare", by("liaison", "Liaison", "liaison-chat"))];
  const workStore = { workThread: (_bot: string, _from: string, _thread: string, _room = false, also: (task: TaskRecord) => boolean = () => true) => opened.find(also) };
  const into = (busy: string[], more: { full?: boolean; kept?: string[]; holding?: string[]; fits?: (task: TaskRecord) => boolean } = {}) => besideBusy(workStore, opened[0]!, {
    botId: "bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", fits: more.fits ?? (() => true), busy: (threadId) => busy.includes(threadId), idle: (threadId) => !busy.includes(threadId) && !(more.holding ?? []).includes(threadId),
    full: more.full ?? false, keeps: (threadId) => (more.kept ?? []).includes(threadId) })?.threadId;

  it("keeps the standing thread while nothing runs there", () => {
    expect(into([])).toBe("standing");
    expect(into(["spare"])).toBe("standing");
  });

  it("runs beside a busy standing thread: in an idle work thread it opened, else a new one", () => {
    expect(into(["standing"])).toBe("spare");
    expect(into(["standing", "spare"])).toBeUndefined();
    expect(into(["standing"], { fits: (task) => task.threadId !== "spare" })).toBeUndefined();
    expect(into(["standing"], { holding: ["spare"] }), "a thread with queued or waiting work is not idle").toBeUndefined();
  });

  it("queues in the standing thread when the teammate could not start it anyway", () => {
    expect(into(["standing"], { full: true })).toBe("standing");
  });

  it("keeps a send behind work this turn handed on or this conversation still waits on, wherever that runs", () => {
    expect(into(["standing"], { kept: ["standing"] })).toBe("standing");
    expect(into(["standing", "spare"], { kept: ["spare"] })).toBe("spare");
  });
});
