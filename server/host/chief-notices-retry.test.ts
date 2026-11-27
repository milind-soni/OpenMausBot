import { describe, expect, it, vi } from "vitest";

import { TRIAL_CREDIT_REFUSED } from "../../shared/trial-credit.ts";
import "../server-line-packs.ts";
import { engineFailureMessage } from "../drivers/engine-errors.ts";
import { memoryStopText } from "../engine-memory.ts";
import { AUTO_RETRY_LEAD, RETRY_BLOCKED } from "../incidents.ts";
import { FROZE_BROWSING } from "../memory-freeze-restart.ts";
import type { RoutineFailureFacts } from "../routine-recovery.ts";
import { _queuedCount, cancelSteeredMessage, drainSteeredMessages, queuedSteerSnapshot } from "../steer-queue.ts";
import { createChiefNotices, failedRequester, MEMORY_RETRY_MS, retriedMessage, MEMORY_RETRY_TEXT, ROOM_RETRY_TEXT, SERVER_MEMORY_RETRY_TEXT, type ChiefNoticeDeps } from "./chief-notices.ts";

function fixture(over: Partial<ChiefNoticeDeps> = {}) {
  const bots = [
    { id: "chief", name: "Clive", chiefOfStaff: true, section: "Ops", threadId: "chief-main", tasks: [] as Array<{ threadId: string; title: string }> },
    { id: "ada", name: "Ada", section: "Ops", threadId: "ada-main", tasks: [{ threadId: "ada-main", title: "Ada" }, { threadId: "ada-job", title: "Invoices" }] },
  ];
  const lines = new Map<string, Array<Record<string, unknown>>>();
  let made = 0;
  const store = {
    bots, bot: (id: string) => bots.find((one) => one.id === id),
    tasks: (id: string) => bots.find((one) => one.id === id)?.tasks ?? [],
    taskByThread: (id: string, threadId: string) => bots.find((one) => one.id === id)?.tasks.find((task) => task.threadId === threadId),
    groupByThread: () => undefined,
    createTask: (id: string, title: string) => {
      const task = { threadId: `notices-${++made}`, title };
      bots.find((one) => one.id === id)!.tasks.push(task);
      return task;
    },
    appendMessage: (threadId: string, row: Record<string, unknown>) => {
      const line = { ...row, at: Date.now() };
      lines.set(threadId, [...(lines.get(threadId) ?? []), line]);
      return line;
    },
    messagesFor: (threadId: string) => lines.get(threadId) ?? [],
    activePath: (threadId: string) => lines.get(threadId) ?? [],
  };
  // As the host's startTurn does, the turn's own message lands in its thread first.
  const startTurn = vi.fn(async (_botId: string, text: string, opts: { threadId: string; peerAsk?: unknown }) => {
    store.appendMessage(opts.threadId, { role: "user", kind: "text", text, peerAsk: opts.peerAsk });
  });
  const notices = createChiefNotices({
    store: store as never, notify: () => {}, threadBusy: () => false, botAtThreadCapacity: () => false,
    groupTurnActive: () => false, startTurn, assignerOf: () => undefined, schedule: (run) => run(), ...over,
  });
  const turnsOf = (botId: string) => startTurn.mock.calls.filter(([id]) => id === botId).map(([, text, opts]) => ({ text, threadId: opts.threadId }));
  return { notices, store, startTurn, turnsOf, chief: bots[0]!, ada: bots[1]! };
}

describe("why a Chief's retry of a teammate's thread is refused", () => {
  it("names a thread that still runs, is shutting down, or waits for a slot", () => {
    expect(fixture({ threadBusy: () => true }).notices.retryRefusal("ada", "ada-job")).toBe(RETRY_BLOCKED.running);
    expect(fixture({ threadBusy: () => true, threadSettling: () => true }).notices.retryRefusal("ada", "ada-job")).toBe(RETRY_BLOCKED.settling);
    expect(fixture({ threadQueued: () => true }).notices.retryRefusal("ada", "ada-job")).toBe(RETRY_BLOCKED.queued);
    expect(fixture().notices.retryRefusal("ada", "ada-job")).toBeNull();
  });

  it("refuses a thread that finished a run since its incident was reported", () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const f = fixture();
      f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "no activity for 20 minutes" });
      expect(f.notices.retryRefusal("ada", "ada-job")).toBeNull();
      vi.setSystemTime(2_000);
      f.store.appendMessage("ada-job", { role: "bot", kind: "text", text: "Done.", turnSucceeded: true });
      expect(f.notices.retryRefusal("ada", "ada-job")).toMatch(/^that thread has finished a run since it was reported/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a Chief's retry of a teammate's busy thread", () => {
  type Drained = { botId: string; threadId: string; prompt: string; unattended: boolean; peerAsk: unknown };
  function drain(f: ReturnType<typeof fixture>, drained: Drained[]): void {
    drainSteeredMessages(
      { bot: (id: string) => f.store.bot(id) ?? null, appendMessage: (threadId: string, row: never) => f.store.appendMessage(threadId, row) } as never,
      (botId, threadId, prompt, _message, _ids, unattended, head) => { drained.push({ botId, threadId, prompt, unattended, peerAsk: head.peerAsk }); },
    );
  }

  it("queues the retry while its bot is mid-turn elsewhere, and the queue starts it when the bot frees up", async () => {
    const f = fixture({ groupTurnActive: (botId) => botId === "ada" });
    const queued = await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, note: "The service was down." });
    expect(queued).toBe("queued");
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(_queuedCount("ada-job")).toBe(1);
    const drained: Drained[] = [];
    drain(f, drained);
    expect(drained).toEqual([{ botId: "ada", threadId: "ada-job",
      prompt: expect.stringContaining("requested by Clive, your Chief of Staff, after this thread's last run stopped. Note from Clive: The service was down."),
      unattended: true, peerAsk: { botId: "chief", name: "Clive", unattended: true } }]);
    expect(drained[0]!.prompt).toContain("Continue the request above from where it stopped and finish it.");
    expect(_queuedCount("ada-job")).toBe(0);
  });

  it("queues with the capacity reason at its bot's turn limit, answering queued rather than failed", async () => {
    const f = fixture({ botAtThreadCapacity: () => true });
    const queued = await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: false });
    expect(queued).toBe("queued");
    const snapshot = queuedSteerSnapshot(() => true);
    expect(snapshot["ada-job"]?.[0]).toMatchObject({ reason: "capacity", text: expect.stringContaining("requested by Clive") });
    cancelSteeredMessage("ada", snapshot["ada-job"]![0]!.queueId, "ada-job");
  });

  it("still refuses a thread that runs, shuts down or already waits, even while its bot is at its turn limit", async () => {
    for (const [over, refusal] of [
      [{ threadBusy: () => true }, RETRY_BLOCKED.running],
      [{ threadBusy: () => true, threadSettling: () => true }, RETRY_BLOCKED.settling],
      [{ threadQueued: () => true }, RETRY_BLOCKED.queued],
    ] as const) {
      const f = fixture({ ...over, botAtThreadCapacity: () => true, groupTurnActive: () => true });
      await expect(f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true })).rejects.toThrow(refusal);
      expect(f.startTurn).not.toHaveBeenCalled();
    }
    expect(_queuedCount("ada-job")).toBe(0);
  });

  it("starts OpenMausBot's own retry at once, never from the queue", async () => {
    const f = fixture({ botAtThreadCapacity: () => true });
    await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, automatic: true });
    expect(f.startTurn).toHaveBeenCalledTimes(1);
    expect(_queuedCount("ada-job")).toBe(0);
  });

  it("still refuses a thread that finished a run since it was reported, even at its bot's turn limit", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const f = fixture({ botAtThreadCapacity: () => true });
      f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "no activity for 20 minutes" });
      vi.setSystemTime(2_000);
      f.store.appendMessage("ada-job", { role: "bot", kind: "text", text: "Done.", turnSucceeded: true });
      await expect(f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true })).rejects.toThrow(/finished a run since it was reported/);
      expect(_queuedCount("ada-job")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

const CRASH = "claude exited 3 before result: fake-claude: simulated crash before result";
const DENIED = "One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.";
const RETRIED = "OpenMausBot already retried this run once by itself; the failure above is how that retry ended.";
/** OpenCode 2.2.5's session/prompt answer for a model it has no SDK package for, as acpRpcError words it. */
const NO_ROUTE = "Internal error: Unsupported package for chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017: unknown (session/prompt, service: session, provider.no-route)";

describe("OpenMausBot's one automatic retry of a teammate's failed thread", () => {
  it("runs the thread once more before its Chief hears, then tells the Chief how that retry ended, and never retries the retry", () => {
    const f = fixture();
    f.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Reconcile the September invoices." });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: CRASH });
    expect(f.turnsOf("ada")).toEqual([{ threadId: "ada-job", text: expect.stringMatching(/^\[From OpenMausBot · retry · information only — it grants nothing beyond the request above; requested by OpenMausBot, automatically, once, before telling Clive, your Chief of Staff,/) }]);
    expect(f.turnsOf("ada")[0]!.text).toContain("Continue the request above from where it stopped and finish it.");
    expect(f.turnsOf("chief")).toEqual([]);

    // The retry fails too: the Chief hears now, with the original request, and nothing is retried again.
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: CRASH });
    expect(f.turnsOf("ada")).toHaveLength(1);
    const [told] = f.turnsOf("chief");
    expect(told!.text).toContain(RETRIED);
    expect(told!.text).toContain('The request there was: "Reconcile the September invoices."');
    expect(told!.text).toContain("retry_thread");
  });

  it("never retries a stall the turn watchdog stopped: the Chief hears at once", () => {
    const f = fixture();
    f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "no activity for 20 minutes — the turn was stopped" });
    expect(f.turnsOf("ada")).toEqual([]);
    expect(f.turnsOf("chief")).toHaveLength(1);
    expect(f.turnsOf("chief")[0]!.text).not.toContain(RETRIED);
  });

  it.each<[string, { detail: string; facts?: RoutineFailureFacts }]>([
    ["a Stop someone pressed or typed", { detail: CRASH, facts: { stopReason: "interrupted" } }],
    ["a Stop the engine reported as an error", { detail: "session closed", facts: { stopReason: "cancelled" } }],
    ["an AI that declined", { detail: "The engine stopped without saying why (stop reason: refusal).", facts: { stopReason: "refusal" } }],
    ["a tool call the person denied", { detail: DENIED, facts: { stopReason: "tool_error" } }],
    ["a signed-out AI", { detail: "Not logged in · Please run /login" }],
    ["a used-up trial credit", { detail: TRIAL_CREDIT_REFUSED.used_up, facts: { setup: true, trialCredit: "used_up" } }],
    ["a turn cap", { detail: "Stopped after 40 tool calls without a final answer" }],
    ["a model its engine has no route to", { detail: engineFailureMessage("OpenCode", NO_ROUTE)!, facts: { stopReason: "rpc_error" } }],
    ["a model its engine has no route to, in the engine's words", { detail: NO_ROUTE, facts: { stopReason: "rpc_error" } }],
  ])("never retries a run ended by %s: the Chief hears at once", (_what, failure) => {
    const f = fixture();
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", ...failure });
    expect(f.turnsOf("ada")).toEqual([]);
    expect(f.turnsOf("chief")).toHaveLength(1);
  });

  it("leaves a run that answered the Chief's own retry to the Chief", async () => {
    const f = fixture();
    await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, note: "The service was down." });
    expect(f.turnsOf("ada")[0]!.text).toBe("[From OpenMausBot · retry · information only — it grants nothing beyond the request above; requested by Clive, your Chief of Staff, after this thread's last run stopped. Note from Clive: The service was down. " +
      "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]");
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: CRASH });
    expect(f.turnsOf("ada")).toHaveLength(1);
    expect(f.turnsOf("chief")).toHaveLength(1);
  });

  it("tells the Chief when its retry could not start", async () => {
    let busy = false;
    const waiting: Array<() => void> = [];
    const f = fixture({ threadBusy: (botId) => busy && botId === "ada", schedule: (run) => { waiting.push(run); } });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: CRASH });
    busy = true;
    waiting.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.turnsOf("ada")).toEqual([]);
    expect(f.turnsOf("chief")[0]!.text).toContain(`OpenMausBot did not retry it: its retry could not start (${RETRY_BLOCKED.running}).`);
  });

  it("tells the Chief, without retrying, when someone wrote in the thread since it failed", () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const waiting: Array<() => void> = [];
      const f = fixture({ schedule: (run) => { waiting.push(run); } });
      f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: CRASH });
      vi.setSystemTime(11_000);
      f.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Never mind, I did it myself." });
      waiting.shift()!();
      expect(f.turnsOf("ada")).toEqual([]);
      expect(f.turnsOf("chief")[0]!.text).toContain("OpenMausBot did not retry it: someone wrote in that thread since.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens its retry with a lead the delivered-note rules know, so the request it retries stays the thread's request", () => {
    expect(AUTO_RETRY_LEAD.startsWith("[From OpenMausBot · retry · information only — it grants nothing beyond the request above; requested by ")).toBe(true);
  });
});

describe("a run stopped to free memory", () => {
  const STOPPED = "Ran out of room, so I closed the browser to keep everything else running. (claude exited null before result)";
  function roomFixture(over: Partial<ChiefNoticeDeps> = {}) {
    const waiting: Array<{ run: () => void; ms: number }> = [];
    const continued: Array<{ botId: string; threadId: string; text: string }> = [];
    const told: unknown[] = [];
    const f = fixture({
      later: (run, ms) => { waiting.push({ run, ms }); },
      continueRequest: async (botId, threadId, text) => { continued.push({ botId, threadId, text }); },
      notify: (notification) => { told.push(notification); },
      ...over,
    });
    // The Chief's own conversation, as the person's chat with it.
    f.chief.tasks.push({ threadId: "chief-main", title: "Clive" });
    return { ...f, waiting, continued, told, settle: () => { for (const { run } of waiting.splice(0)) run(); } };
  }

  it("starts once more by itself after the machine settles, with no Chief to retry it, and the person hears only if that fails too", async () => {
    const f = roomFixture();
    f.store.appendMessage("chief-main", { role: "user", kind: "text", text: "Book the train to Leeds." });
    f.notices.reportIncident({ kind: "failed", bot: f.chief as never, threadId: "chief-main", detail: STOPPED });
    expect(f.told).toEqual([]);
    expect(f.waiting.map(({ ms }) => ms)).toEqual([MEMORY_RETRY_MS]);
    expect(MEMORY_RETRY_MS).toBe(30_000);
    f.settle();
    expect(f.continued).toEqual([{ botId: "chief", threadId: "chief-main", text: MEMORY_RETRY_TEXT }]);
    expect(f.startTurn).not.toHaveBeenCalled();
    // That run is stopped for memory too: the person hears now, and nothing starts again.
    f.notices.reportIncident({ kind: "failed", bot: f.chief as never, threadId: "chief-main", detail: STOPPED });
    f.settle();
    expect(f.continued).toHaveLength(1);
    expect(f.told).toHaveLength(1);
  });

  it("starts a turn whose browser was closed for memory again once, never twice for one request, so a heavy page cannot loop", () => {
    const f = roomFixture();
    const closedBrowser = `${memoryStopText(true)} (claude exited null before result)`;
    f.store.appendMessage("chief-main", { role: "user", kind: "text", text: "Read the long report." });
    for (let stop = 0; stop < 3; stop++) {
      f.notices.reportIncident({ kind: "failed", bot: f.chief as never, threadId: "chief-main", detail: closedBrowser });
      f.settle();
    }
    expect(f.continued).toHaveLength(1);
    expect(f.told).toHaveLength(2);
  });

  it("starts nothing when someone wrote in the thread since, or it runs or waits again", () => {
    const wrote = roomFixture();
    wrote.store.appendMessage("chief-main", { role: "user", kind: "text", text: "Book the train." });
    wrote.notices.reportIncident({ kind: "failed", bot: wrote.chief as never, threadId: "chief-main", detail: STOPPED });
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    try {
      wrote.store.appendMessage("chief-main", { role: "user", kind: "text", text: "Never mind, I booked it." });
    } finally {
      vi.useRealTimers();
    }
    wrote.settle();
    expect(wrote.continued).toEqual([]);
    const busy = roomFixture({ threadBusy: () => true });
    busy.notices.reportIncident({ kind: "failed", bot: busy.chief as never, threadId: "chief-main", detail: STOPPED });
    busy.settle();
    expect(busy.continued).toEqual([]);
  });

  it("never starts again a routine run that the restart after a memory freeze ended", () => {
    const f = roomFixture();
    f.store.appendMessage("chief-main", { role: "user", kind: "text", text: "Check the prices page." });
    f.notices.reportIncident({ kind: "routine-failed", bot: f.chief as never, threadId: "chief-main", detail: `Prices: ${FROZE_BROWSING}`, failure: FROZE_BROWSING });
    f.settle();
    expect(f.waiting).toEqual([]);
    expect(f.continued).toEqual([]);
  });

  it("on a self-hosted server, starts a teammate's run again by itself too, saying it was this server, and asks no Chief", () => {
    const f = roomFixture({ selfHosted: () => true });
    f.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Reconcile the September invoices." });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: STOPPED });
    expect(f.turnsOf("ada")).toEqual([]);
    f.settle();
    expect(f.continued).toEqual([{ botId: "ada", threadId: "ada-job", text: SERVER_MEMORY_RETRY_TEXT }]);
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.turnsOf("chief")).toEqual([]);
  });

  it("leaves a teammate's run to the Chief's own retry, and any other failure to the person", () => {
    const teammate = roomFixture();
    teammate.notices.reportIncident({ kind: "failed", bot: teammate.ada as never, threadId: "ada-job", detail: STOPPED });
    expect(teammate.turnsOf("ada")).toEqual([{ threadId: "ada-job", text: expect.stringMatching(/^\[From OpenMausBot · retry · information only — it grants nothing beyond the request above; requested by OpenMausBot, automatically, once/) }]);
    expect(teammate.waiting).toEqual([]);
    const other = roomFixture();
    other.notices.reportIncident({ kind: "failed", bot: other.chief as never, threadId: "chief-main", detail: CRASH });
    expect([other.waiting, other.told.length]).toEqual([[], 1]);
  });
});

describe("the person's line about an incident", () => {
  it("lands in a notices chat older versions named Team incidents, rather than opening a second one", () => {
    const f = fixture();
    f.chief.tasks.push({ threadId: "old-notices", title: "Team incidents" });
    f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "" });
    expect(f.store.messagesFor("old-notices").some((line) => line.kind === "activity")).toBe(true);
    expect(f.chief.tasks.map((task) => task.title)).toEqual(["Team incidents"]);
  });

  it("is in the language of the person whose work failed, while the Chief's report stays English", () => {
    const f = fixture({ threadLanguage: (threadId) => (threadId === "ada-job" ? "de" : undefined) });
    f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "" });
    const row = f.store.messagesFor("notices-1").find((line) => line.kind === "activity") as { tool: { name: string } } | undefined;
    expect(row?.tool.name).toBe("Ada hatte ein Problem: Die Ausführung im Thread #Invoices wurde gestoppt, weil sie keine Aktivität mehr zeigte");
    expect(f.turnsOf("chief")[0]!.text).toContain("Ada's run in its thread #Invoices stopped after showing no activity");
  });
});

describe("a problem in a conversation that runs confined", () => {
  it("reaches a person, never a Chief's turn at the Chief's own level", () => {
    const notify = vi.fn();
    const f = fixture({ confined: (threadId) => threadId === "ada-job", notify });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: "the turn stopped" });
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("is not started again by itself through a Chief", () => {
    const f = fixture({ confined: (threadId) => threadId === "ada-job" });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: "the turn stopped" });
    expect(f.turnsOf("ada")).toEqual([]);
  });

  it("a conversation that is not confined still reaches its Chief", () => {
    const f = fixture({ confined: () => false });
    f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "no activity" });
    expect(f.turnsOf("chief")).toHaveLength(1);
  });
});

describe("a run the server had no room to start", () => {
  const NO_ROOM = "There is no room to start another program (EAGAIN), so this task could not run. Nothing was sent to the AI. It starts again by itself when there is room.";

  function shortFixture(over: Partial<ChiefNoticeDeps> = {}) {
    const waiting: Array<{ run: () => void; ms: number }> = [];
    const continued: Array<{ botId: string; threadId: string; text: string }> = [];
    const told: unknown[] = [];
    const f = fixture({
      later: (run, ms) => { waiting.push({ run, ms }); },
      continueRequest: async (botId, threadId, text) => { continued.push({ botId, threadId, text }); },
      notify: (notification) => { told.push(notification); },
      ...over,
    });
    return { ...f, waiting, continued, told, settle: () => { for (const { run } of waiting.splice(0)) run(); } };
  }

  it("starts again by itself once, half a minute on, and no Chief's turn is started about it, though the teammate has one", () => {
    const f = shortFixture();
    f.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Reconcile the September invoices." });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: NO_ROOM });
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.told).toEqual([]);
    expect(f.waiting.map(({ ms }) => ms)).toEqual([MEMORY_RETRY_MS]);
    f.settle();
    expect(f.continued).toEqual([{ botId: "ada", threadId: "ada-job", text: ROOM_RETRY_TEXT }]);
    // That start finds no room either: the person hears, once, and still no Chief is asked and nothing starts again.
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: NO_ROOM });
    f.settle();
    expect(f.continued).toHaveLength(1);
    expect(f.told).toHaveLength(1);
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.turnsOf("chief")).toEqual([]);
  });

  it("does the same for a turn that could not start at all, and for Node's own words for the refusal", () => {
    const f = shortFixture();
    f.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Reconcile the September invoices." });
    f.notices.reportIncident({ kind: "could-not-start", bot: f.ada as never, threadId: "ada-job", detail: "spawn failed: spawn /usr/local/bin/claude EAGAIN" });
    f.settle();
    expect(f.continued).toEqual([{ botId: "ada", threadId: "ada-job", text: ROOM_RETRY_TEXT }]);
    expect(f.startTurn).not.toHaveBeenCalled();
  });

  it("only tells the person where nothing can start it again, and leaves every other failure as it was", () => {
    const told: unknown[] = [];
    const bare = fixture({ notify: (notification) => { told.push(notification); } });
    bare.notices.reportIncident({ kind: "failed", bot: bare.ada as never, threadId: "ada-job", detail: NO_ROOM });
    expect(told).toHaveLength(1);
    expect(bare.startTurn).not.toHaveBeenCalled();
    // A crash still gets the teammate's one retry and then its Chief.
    const crash = shortFixture();
    crash.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Reconcile the September invoices." });
    crash.notices.reportIncident({ kind: "failed", bot: crash.ada as never, threadId: "ada-job", detail: CRASH });
    expect(crash.turnsOf("ada")).toHaveLength(1);
    expect(crash.turnsOf("ada")[0]!.text.startsWith(AUTO_RETRY_LEAD)).toBe(true);
    expect(crash.continued).toEqual([]);
  });
});

describe("a Chief's retry of a thread that failed the Chief's own request", () => {
  const sent = { status: 200, body: { receipts: [{ botId: "ada", botName: "Ada", outcome: "queued", threadId: "ada-job" }] } };
  const node = (over: Record<string, unknown>) => ({ id: "child", parentId: "chief-turn", threadId: "ada-job", botId: "ada", status: "failed", reply: "resume", mode: "work", ...over });
  const coordinator = (last: Record<string, unknown> | undefined) => ({
    inThread: () => (last ? [node({ id: "older", status: "completed" }), last] : []) as never,
    node: (id: string) => (id === "chief-turn" ? { id, botId: "chief", threadId: "chief-main" } : undefined) as never,
  });
  const requester = (last: Record<string, unknown> | undefined) => failedRequester(coordinator(last), "ada-job");

  it("knows which bot asked, with reply resume, for the failed work, and nobody for anything else", () => {
    expect(requester(node({}))).toEqual({ botId: "chief", consult: false });
    expect(requester(node({ mode: "consult" }))).toEqual({ botId: "chief", consult: true });
    expect(requester(node({ status: "completed" }))).toBeUndefined();
    expect(requester(node({ reply: "none" }))).toBeUndefined();
    expect(requester(node({ parentId: undefined }))).toBeUndefined();
    expect(requester(undefined)).toBeUndefined();
  });

  it("asks again from the Chief's own turn, so the result wakes the Chief, and says so", async () => {
    const coordinateBots = vi.fn(async () => sent);
    const f = fixture({ failedRequester: () => ({ botId: "chief", consult: false }) });
    const how = await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, note: "The service was down.", coordinateBots });
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(coordinateBots).toHaveBeenCalledWith(expect.objectContaining({ botIds: ["ada"], thread: "ada-job", reply: "resume", consult: false }));
    expect(how).toBe("request");
    expect(retriedMessage("Ada", "Invoices", "request")).toContain("resumes you");
  });

  it("asks a failed question again as a question, so the teammate still acts on nothing", async () => {
    const coordinateBots = vi.fn(async () => sent);
    const f = fixture({ failedRequester: () => ({ botId: "chief", consult: true }) });
    expect(await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: false, coordinateBots })).toBe("request");
    expect(coordinateBots).toHaveBeenCalledWith(expect.objectContaining({ reply: "resume", consult: true }));
  });

  it("tells the Chief why when that request could not be sent", async () => {
    const coordinateBots = vi.fn(async () => ({ status: 403, body: { error: "not reachable" } }));
    const f = fixture({ failedRequester: () => ({ botId: "chief", consult: false }) });
    await expect(f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, coordinateBots })).rejects.toThrow("not reachable");
    expect(f.startTurn).not.toHaveBeenCalled();
  });

  it("retries every other thread as before: another bot's request, the person's own work, or OpenMausBot's automatic retry", async () => {
    for (const [requested, automatic] of [["someone-else", false], [undefined, false], ["chief", true]] as const) {
      const coordinateBots = vi.fn(async () => sent);
      const f = fixture({ failedRequester: () => (requested ? { botId: requested, consult: false } : undefined) });
      const how = await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, coordinateBots, ...(automatic ? { automatic: true as const } : {}) });
      expect(coordinateBots).not.toHaveBeenCalled();
      expect(f.turnsOf("ada")).toHaveLength(1);
      expect(how).toBe("turn");
    }
    expect(retriedMessage("Ada", "Invoices", "turn")).toBe("Ada's thread #Invoices is running again. Its result stays in that thread; you are not woken for it — check later with list_threads or session_search if you need to.");
  });

  it("from a room, where the server passes no coordinate_bots, retries the Chief's own request in the failed thread as a turn", async () => {
    const f = fixture({ failedRequester: () => ({ botId: "chief", consult: false }) });
    const how = await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: false });
    expect(f.turnsOf("ada")).toEqual([{ threadId: "ada-job", text: expect.stringContaining("Continue the request above from where it stopped and finish it.") }]);
    expect(f.turnsOf("chief")).toEqual([]);
    expect(how).toBe("turn");
  });
});
