import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, Message, StoreChange, TaskRecord } from "../store.ts";
import { WaitManager } from "../waits.ts";
import { archivedOnResult, archivesOnResult, closesOnResult, createHandedClose, finishHandedThread, type HandedCloseDeps, opensAgain, reopenHandedThread, STOP_GRACE_MS, stoppedByPerson, SYSTEM_STOP } from "./finished-work.ts";

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

  it("closes the standing work thread, and leaves it in the sidebar", () => {
    const store = fakeStore({ openedBy: opened({ kind: "work" }), unread: true });
    finishHandedThread(store, "lead", "lead-thread", "chief", 42);
    expect(store.record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 42 });
    expect(store.calls).toEqual(["closed"]);
  });

  it("leaves a one-shot thread to createHandedClose, and a thread that stays open alone", () => {
    for (const task of [{ openedBy: oneShot() }, { openedBy: oneShot(), pinned: true }, { openedBy: oneShot({ kind: "pair" as const }) }, { openedBy: opened() }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", 42);
      expect(store.calls).toEqual([]);
    }
  });
});

describe("reopenHandedThread", () => {
  const closedBy = { botId: "chief", name: "Clive", at: 5 };
  it("takes a one-shot thread out of the archive its ended work put it in, and takes that close off", () => {
    const calls: unknown[] = [];
    const store = {
      patchTask: (_botId: string, _threadId: string, patch: unknown) => { calls.push(patch); return null; },
      setTaskClosedBy: (_botId: string, _threadId: string, closed: unknown) => { calls.push({ closedBy: closed }); return null; },
    };
    reopenHandedThread(store, "lead", { threadId: "t", openedBy: oneShot(), closedBy, archivedAt: 5 });
    reopenHandedThread(store, "lead", { threadId: "t", openedBy: oneShot() });
    expect(calls).toEqual([{ archivedAt: undefined }, { closedBy: null }]);
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

  it("follows queued work the person's Stop ended before it started or resumed to that Stop, and a system stop to the system", () => {
    for (const cause of ["Stopped before it started", "Stopped before it resumed"]) {
      expect(stoppedByPerson(ended({ outcomeDetail: cause }), { outcomeDetail: "Stopped by user" })).toBe(true);
      expect(stoppedByPerson(ended({ outcomeDetail: cause }), { outcomeDetail: "The coordinated turn was cut" })).toBe(false);
      expect(stoppedByPerson(ended({ outcomeDetail: cause }), { outcomeDetail: "Stopped by @Clive, who handed this work on" })).toBe(false);
      expect(stoppedByPerson(ended({ outcomeDetail: cause }))).toBe(false);
    }
  });

  it("follows work handed on twice up to the conversation whose stop ended it", () => {
    const nodes: Record<string, Pick<HandoffView, "outcomeDetail" | "parentId">> = {
      person: { outcomeDetail: "Stopped by user" },
      system: { outcomeDetail: "The routine restarted" },
    };
    const middle = (root: string) => ({ outcomeDetail: "Stopped with the request it was for", parentId: root });
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped before it started" }), middle("person"), (id) => nodes[id])).toBe(true);
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped with the request it was for" }), middle("person"), (id) => nodes[id])).toBe(true);
    expect(stoppedByPerson(ended({ outcomeDetail: "Stopped before it started" }), middle("system"), (id) => nodes[id])).toBe(false);
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

  /** One saved thread of "lead" that "chief" handed work to. Each change to it says so, as the store does. */
  const world = (task: Partial<TaskRecord>, live = { working: false, waitArmed: false }) => {
    const record = { threadId: "lead-thread", title: "Work", ...task } as TaskRecord;
    const bots = [{ id: "lead", name: "Lee", tasks: [record] }] as unknown as BotRecord[];
    const listeners = new Set<(change: StoreChange) => void>();
    const emit = (change: StoreChange) => { for (const listener of listeners) listener(change); };
    const changed = () => { emit({ type: "bot", botId: "lead", threadId: record.threadId }); return record; };
    const store = {
      bots,
      bot: (botId: string) => (botId === "chief" ? { name: "Clive" } : undefined) as never,
      botByThread: (threadId: string) => (threadId === record.threadId ? bots[0] : undefined) as never,
      taskByThread: (_botId: string, threadId: string) => threadId === record.threadId ? record : undefined,
      setTaskClosedBy: (_botId: string, _threadId: string, closedBy: TaskRecord["closedBy"] | null) => { record.closedBy = closedBy ?? undefined; return changed(); },
      setTaskOpenedBy: (_botId: string, _threadId: string, openedBy: TaskRecord["openedBy"]) => { record.openedBy = openedBy; return changed(); },
      patchTask: (_botId: string, _threadId: string, patch: Partial<TaskRecord>) => { Object.assign(record, patch); return changed(); },
      onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const start = (more: Partial<HandedCloseDeps> = {}) => { const close = createHandedClose({ store, working: () => live.working, waitArmed: () => live.waitArmed, ...more }); vi.advanceTimersByTime(0); return close; };
    const write = (message: Partial<Message>) => emit({ type: "message", threadId: record.threadId, message: message as Message });
    /** Something on the thread changed outside this module: it was read, a question was answered, a turn ended. */
    const update = (patch: Partial<TaskRecord>) => { Object.assign(record, patch); changed(); };
    return { record, live, start, write, update, emit };
  };
  const chief = { id: "chief-node", botId: "chief", threadId: "chief-chat" } as HandoffView;
  const work = (more: Partial<HandoffView>) => ({ id: "h1", parentId: "chief-node", botId: "lead", threadId: "lead-thread", status: "completed", ...more }) as HandoffView;
  const personStop = work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped by user" });
  const failed = work({ status: "failed", outcome: "provider_error" });
  const closedAt = (at: number) => ({ closedBy: { botId: "chief", name: "Clive", at }, archivedAt: at });

  it("closes and archives a one-shot thread when its work is done, failed, or stopped by the bot that handed it on", () => {
    for (const ended of [work({}), failed, work({ status: "failed", outcome: "stalled" }),
      work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped by @Clive, who handed this work on" })]) {
      const { record, start } = world({ openedBy: oneShot() });
      start().ended(ended, chief, false);
      expect(record).toMatchObject(closedAt(1_000_000));
      expect(record.openedBy).toEqual(oneShot());
    }
  });

  it("closes at once work the server stopped itself, without the person's hour", () => {
    for (const cause of Object.values(SYSTEM_STOP)) {
      const { record, start } = world({ openedBy: oneShot() });
      start().ended(work({ status: "cancelled", outcome: "stopped", outcomeDetail: cause }), chief, false);
      expect(record).toMatchObject(closedAt(1_000_000));
    }
  });

  it("only closes the standing work thread when its work fails", () => {
    const { record, start } = world({ openedBy: opened({ kind: "work" }) });
    start().ended(failed, chief, false);
    expect(record.closedBy?.botId).toBe("chief");
    expect(record.archivedAt).toBeUndefined();
  });

  it("leaves a done result its requester could not take open", () => {
    const withheld = world({ openedBy: oneShot() });
    withheld.start().ended(work({}), chief, true);
    expect(withheld.record.closedBy).toBeUndefined();
    expect(withheld.record.openedBy?.closesAt).toBeUndefined();
  });

  it("keeps a thread whose work ended open while a bot still works there, and closes it when that turn ends", () => {
    const cases: Array<[Partial<TaskRecord>, boolean]> = [[{}, true], [{ activity: "working" }, false], [{ busy: true }, false]];
    for (const [task, working] of cases) {
      const { record, live, start, update } = world({ openedBy: oneShot(), ...task }, { working, waitArmed: false });
      const from = Date.now();
      start().ended(failed, chief, false);
      expect(record.closedBy).toBeUndefined();
      expect(record.archivedAt).toBeUndefined();
      vi.advanceTimersByTime(2 * STOP_GRACE_MS);
      expect(record.archivedAt).toBeUndefined();
      live.working = false;
      update({ activity: "idle", busy: false });
      expect(record).toMatchObject(closedAt(from + 2 * STOP_GRACE_MS));
    }
  });

  it("neither closes nor archives a thread that waits on the person, and closes it once that is settled", () => {
    const cases: Array<[Partial<TaskRecord>, { working: boolean; waitArmed: boolean }, (w: ReturnType<typeof world>) => void]> = [
      [{ unread: true }, { working: false, waitArmed: false }, (w) => w.update({ unread: false })],
      [{ activity: "waiting-on-you" }, { working: false, waitArmed: false }, (w) => w.update({ activity: "idle" })],
    ];
    for (const [task, live, settle] of cases) {
      const w = world({ openedBy: oneShot(), ...task }, { ...live });
      const from = Date.now();
      w.start().ended(work({}), chief, false);
      expect(w.record.closedBy).toBeUndefined();
      expect(w.record.archivedAt).toBeUndefined();
      expect(w.record.openedBy?.closesAt).toBe(from);
      vi.advanceTimersByTime(5_000);
      settle(w);
      expect(w.record).toMatchObject(closedAt(from + 5_000));
    }
  });

  describe("with the thread's bot waiting on something", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    /** The real wait list, as the host wires it: a wait going tells the close to look again. */
    const waiting = async (w: ReturnType<typeof world>, followUp?: string, post: () => boolean = () => true, report = { there: false }) => {
      const dir = mkdtempSync(join(tmpdir(), "omb-handed-waits-"));
      dirs.push(dir);
      let close: ReturnType<typeof createHandedClose> | undefined;
      const waits = new WaitManager({
        file: join(dir, "waits.json"), now: () => Date.now(), probes: { stamp: async () => (report.there ? { size: 4, mtimeMs: 1 } : null) },
        sourceAlive: () => true, botBusy: () => false, post, followUp: () => {}, showCard: () => "card-1", settleCard: () => {},
        ended: (wait) => close?.look(wait.botId),
      });
      close = w.start({ waitArmed: (botId, threadId) => waits.all().some((wait) => wait.botId === botId && wait.threadId === threadId) });
      const made = await waits.create({ botId: "lead", threadId: "lead-thread", label: "the report", condition: { kind: "file_exists", path: "/nowhere/report.pdf" }, ...(followUp ? { followUp } : {}) });
      if (made.state !== "created") throw new Error(`no wait: ${made.state}`);
      return { close, waits, wait: made.wait };
    };

    it("closes the thread once the last wait there is cancelled, with nothing else changing", async () => {
      for (const followUp of [undefined, "Send the report on"]) {
        const w = world({ openedBy: oneShot() });
        const { close, waits, wait } = await waiting(w, followUp);
        const from = Date.now();
        close.ended(work({}), chief, false);
        expect(w.record.closedBy).toBeUndefined();
        expect(w.record.archivedAt).toBeUndefined();
        vi.advanceTimersByTime(5_000);
        expect(waits.cancel(wait.id, "lead")).not.toBeNull();
        expect(w.record).toMatchObject(closedAt(from + 5_000));
      }
    });

    it("keeps the thread open through a wait's firing, so its message is read there, and closes it once read", async () => {
      const w = world({ openedBy: oneShot() });
      const report = { there: false };
      // As the host posts a wait's message: the line lands first, then the thread is marked unread.
      const { close, waits } = await waiting(w, undefined, () => {
        w.emit({ type: "message", threadId: "lead-thread", message: { role: "bot", kind: "text" } as Message });
        w.update({ unread: true });
        return true;
      }, report);
      close.ended(work({}), chief, false);
      report.there = true;
      vi.advanceTimersByTime(60_000);
      await waits.tick();
      expect(waits.all()).toEqual([]);
      expect(w.record.unread).toBe(true);
      expect(w.record.closedBy).toBeUndefined();
      expect(w.record.archivedAt).toBeUndefined();
      w.update({ unread: false });
      expect(w.record.archivedAt).toBe(1_000_000 + 60_000);
    });

    it("closes the thread once its bot, and so its waits, are gone", async () => {
      const w = world({ openedBy: oneShot() });
      const { close, waits } = await waiting(w);
      close.ended(work({}), chief, false);
      expect(w.record.archivedAt).toBeUndefined();
      expect(waits.removeForBot("lead")).toBe(1);
      expect(w.record.archivedAt).toBe(1_000_000);
    });
  });

  it("looks again when a card in a due thread is settled, though the bot does not change", () => {
    const { record, start, live, emit } = world({ openedBy: oneShot() }, { working: true, waitArmed: false });
    start().ended(work({}), chief, false);
    expect(record.archivedAt).toBeUndefined();
    live.working = false;
    emit({ type: "message.patch", threadId: "lead-thread", message: { role: "bot" } as Message });
    expect(record.archivedAt).toBe(1_000_000);
  });

  it("gives queued work the person's Stop ended before it started or resumed the hour, and closes it at once for a system stop", () => {
    for (const cause of ["Stopped before it started", "Stopped before it resumed"]) {
      const person = world({ openedBy: oneShot() });
      person.start().ended(work({ status: "cancelled", outcome: "stopped", outcomeDetail: cause }), { ...chief, outcomeDetail: "Stopped by user" }, false);
      expect(person.record.archivedAt).toBeUndefined();
      expect(person.record.openedBy?.closesAt).toBe(Date.now() + STOP_GRACE_MS);
      const system = world({ openedBy: oneShot() });
      system.start().ended(work({ status: "cancelled", outcome: "stopped", outcomeDetail: cause }), { ...chief, outcomeDetail: SYSTEM_STOP.turn }, false);
      expect(system.record).toMatchObject(closedAt(Date.now()));
    }
  });

  it("gives work handed on from work the person stopped the hour, reading up the line", () => {
    const { record, start } = world({ openedBy: oneShot() });
    const nodes: Record<string, HandoffView> = { root: { ...chief, id: "root", outcomeDetail: "Stopped by user" } };
    const middle = { ...chief, id: "chief-node", parentId: "root", outcomeDetail: "Stopped with the request it was for" } as HandoffView;
    start({ node: (id) => nodes[id] }).ended(work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped before it started" }), middle, false);
    expect(record.closedBy).toBeUndefined();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(record.archivedAt).toBe(1_000_000 + STOP_GRACE_MS);
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
    expect(record).toMatchObject(closedAt(1_000_000 + STOP_GRACE_MS));
    expect(record.openedBy).toEqual(oneShot());
  });

  it("keeps the standing work thread the person stopped open for an hour too, then only closes it", () => {
    const { record, start } = world({ openedBy: opened({ kind: "work" }) });
    start().ended(personStop, chief, false);
    expect(record.closedBy).toBeUndefined();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 1_000_000 + STOP_GRACE_MS });
    expect(record.archivedAt).toBeUndefined();
    expect(record.openedBy).toEqual(opened({ kind: "work" }));
  });

  it("waits the hour too when the person stopped the conversation that handed the work on", () => {
    const { record, start } = world({ openedBy: oneShot() });
    start().ended(work({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped with the request it was for" }), { ...chief, outcomeDetail: "Stopped by user" }, false);
    expect(record.closedBy).toBeUndefined();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(record.archivedAt).toBe(1_000_000 + STOP_GRACE_MS);
  });

  it("forgets a deleted bot's due threads: the hour that comes closes nothing", () => {
    const { record, start, emit } = world({ openedBy: oneShot() });
    start().ended(personStop, chief, false);
    emit({ type: "bot.deleted", botId: "lead" });
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(record.closedBy).toBeUndefined();
    expect(record.archivedAt).toBeUndefined();
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

  it("closes at once on restart a stopped thread whose hour passed while the server was down", () => {
    const { record, start } = world({ openedBy: oneShot({ closesAt: 1_000_000 - 1 }) });
    start();
    expect(record.archivedAt).toBe(1_000_000);
  });

  it("at the hour, keeps a stopped thread a bot works in due, and closes it when the turn ends", () => {
    const { record, live, start, update } = world({ openedBy: oneShot() });
    start().ended(personStop, chief, false);
    live.working = true;
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(record.closedBy).toBeUndefined();
    expect(record.openedBy?.closesAt).toBe(1_000_000 + STOP_GRACE_MS);
    vi.advanceTimersByTime(60_000);
    live.working = false;
    update({});
    expect(record).toMatchObject(closedAt(1_000_000 + STOP_GRACE_MS + 60_000));
  });

  it("takes a closed one-shot thread out of the archive, and takes the close off, on a new message; not on the lines a run leaves", () => {
    const { record, start, write } = world({ openedBy: oneShot() });
    start().ended(work({}), chief, false);
    write({ role: "bot", kind: "activity" });
    expect(record).toMatchObject(closedAt(1_000_000));
    write({ role: "bot", threadPost: { deliveryId: "d", fromBotId: "chief", fromThreadId: "chief-chat" } });
    expect(record.archivedAt).toBeUndefined();
    expect(record.closedBy).toBeUndefined();
  });

  it("drops the due close of a thread the person pinned meanwhile", () => {
    const { record, start, update } = world({ openedBy: oneShot(), unread: true });
    start().ended(work({}), chief, false);
    update({ pinned: true, unread: false });
    expect(record.closedBy).toBeUndefined();
    expect(record.openedBy?.closesAt).toBeUndefined();
  });

  it("never closes a thread the person started, or one start_thread opened, however its work ends", () => {
    for (const task of [{}, { openedBy: opened() }]) {
      for (const ended of [work({}), failed, personStop]) {
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
