import { describe, expect, it, vi } from "vitest";

import { TRIAL_CREDIT_REFUSED } from "../../shared/trial-credit.ts";
import "../server-line-packs.ts";
import { AUTO_RETRY_LEAD, RETRY_BLOCKED } from "../incidents.ts";
import type { RoutineFailureFacts } from "../routine-recovery.ts";
import { createChiefNotices, MEMORY_RETRY_MS, MEMORY_RETRY_TEXT, type ChiefNoticeDeps } from "./chief-notices.ts";

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
    groupTurnActive: () => false, startTurn, assignerOf: () => undefined, escalationsEnabled: () => true, schedule: (run) => run(), ...over,
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

const CRASH = "claude exited 3 before result: fake-claude: simulated crash before result";
const DENIED = "One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.";
const RETRIED = "OpenMausBot already retried this run once by itself; the failure above is how that retry ended.";

describe("OpenMausBot's one automatic retry of a teammate's failed thread", () => {
  it("runs the thread once more before its Chief hears, then tells the Chief how that retry ended, and never retries the retry", () => {
    const f = fixture();
    f.store.appendMessage("ada-job", { role: "user", kind: "text", text: "Reconcile the September invoices." });
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", detail: CRASH });
    expect(f.turnsOf("ada")).toEqual([{ threadId: "ada-job", text: expect.stringMatching(/^\[Retry requested by OpenMausBot, automatically, once, before telling Clive, your Chief of Staff,/) }]);
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
  ])("never retries a run ended by %s: the Chief hears at once", (_what, failure) => {
    const f = fixture();
    f.notices.reportIncident({ kind: "failed", bot: f.ada as never, threadId: "ada-job", ...failure });
    expect(f.turnsOf("ada")).toEqual([]);
    expect(f.turnsOf("chief")).toHaveLength(1);
  });

  it("leaves a run that answered the Chief's own retry to the Chief", async () => {
    const f = fixture();
    await f.notices.retryThread({ chief: f.chief as never, bot: f.ada as never, threadId: "ada-job", unattended: true, note: "The service was down." });
    expect(f.turnsOf("ada")[0]!.text).toBe("[Retry requested by Clive, your Chief of Staff, after this thread's last run stopped. Note from Clive: The service was down. " +
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
    expect(AUTO_RETRY_LEAD.startsWith("[Retry requested by ")).toBe(true);
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

  it("leaves a teammate's run to the Chief's own retry, and any other failure to the person", () => {
    const teammate = roomFixture();
    teammate.notices.reportIncident({ kind: "failed", bot: teammate.ada as never, threadId: "ada-job", detail: STOPPED });
    expect(teammate.turnsOf("ada")).toEqual([{ threadId: "ada-job", text: expect.stringMatching(/^\[Retry requested by OpenMausBot, automatically, once/) }]);
    expect(teammate.waiting).toEqual([]);
    const other = roomFixture();
    other.notices.reportIncident({ kind: "failed", bot: other.chief as never, threadId: "chief-main", detail: CRASH });
    expect([other.waiting, other.told.length]).toEqual([[], 1]);
  });
});

describe("the person's line about an incident", () => {
  it("is in the language of the person whose work failed, while the Chief's report stays English", () => {
    const f = fixture({ threadLanguage: (threadId) => (threadId === "ada-job" ? "de" : undefined) });
    f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "" });
    const row = f.store.messagesFor("notices-1").find((line) => line.kind === "activity") as { tool: { name: string } } | undefined;
    expect(row?.tool.name).toBe("Vorfall: Die Ausführung von Ada im Thread #Invoices wurde gestoppt, weil sie keine Aktivität mehr zeigte");
    expect(f.turnsOf("chief")[0]!.text).toContain("Ada's run in its thread #Invoices stopped after showing no activity");
  });
});
