import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { selectDefaultModelSelection, type SelectableInstance } from "./default-model-selection.ts";
import type { CheckableEngine } from "./engine-check.ts";
import { backgroundAiChecks, configIdentity, createTestedAi, type TestedAiDeps } from "./tested-ai.ts";

type Message = { role: string };
type Task = { threadId: string; modelSelection?: ModelSelection };
type Bot = { id: string; chiefOfStaff?: boolean; modelSelection: ModelSelection; tasks: Task[] };
type Change = { type: string; botId?: string; threadId?: string; message?: Message };

const MINUTE = 60_000;
const ready = (instanceId: string, driverKind: string, snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
  instanceId, driverKind, snapshot: { state: "available", authenticated: true, ...snapshot },
  models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: instanceId }] },
});
const on = (instanceId: string): ModelSelection => ({ instanceId, model: `${instanceId}-model` });
const silent = async (): Promise<string> => { throw new Error("529 overloaded"); };

/** What the server's store does here: bots and their conversations, the first bot it seeds, and change events. */
class FakeStore {
  bots: Bot[] = [];
  messages = new Map<string, Message[]>();
  private listeners = new Set<(change: Change) => void>();
  private seedSelection: () => ModelSelection;
  constructor(seedSelection: () => ModelSelection) {
    this.seedSelection = seedSelection;
  }
  needsSeed() { return this.bots.length === 0; }
  seedIfEmpty() {
    if (this.bots.length) return;
    this.bots.unshift({ id: "chief", chiefOfStaff: true, modelSelection: structuredClone(this.seedSelection()), tasks: [{ threadId: "chief-main" }] });
    this.emit({ type: "bot", botId: "chief" });
  }
  bot(id: string) { return this.bots.find((bot) => bot.id === id); }
  tasks(botId: string) { return this.bot(botId)?.tasks ?? []; }
  messagesFor(threadId: string) { return this.messages.get(threadId) ?? []; }
  applyModelDefault = vi.fn((botId: string, selection: ModelSelection) => this.choose(botId, selection));
  /** Anything that sets a bot's model: the person's picker, a team setup, the app's own default. */
  choose(botId: string, selection: ModelSelection) {
    const bot = this.bot(botId)!;
    bot.modelSelection = structuredClone(selection);
    this.emit({ type: "bot", botId });
    return bot;
  }
  say(threadId: string, role: string) {
    const message = { role };
    this.messages.set(threadId, [...this.messagesFor(threadId), message]);
    this.emit({ type: "message", threadId, message });
  }
  onChange(listener: (change: Change) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(change: Change) { for (const listener of this.listeners) listener(change); }
}

describe("testing an AI with one tiny message before a new bot's default trusts it", () => {
  let instances: SelectableInstance[];
  let answers: Record<string, () => Promise<string>>;
  let engines: Map<string, CheckableEngine>;
  let store: FakeStore;
  let saved: ModelSelection | undefined;
  let profile: ModelSelection | undefined;
  let pick: ModelSelection;
  let busy: Set<string>;
  let clock: number;
  let timers: Array<{ at: number; run: () => void; cancelled: boolean }>;
  let data: string;
  let company: (instanceId: string) => boolean;
  let tested: ReturnType<typeof createTestedAi>;

  const engineFor = (instanceId: string): CheckableEngine => {
    let engine = engines.get(instanceId);
    if (!engine) {
      engine = { instanceId, displayName: instanceId, driverKind: instanceId, generateText: vi.fn(() => answers[instanceId]!()) };
      engines.set(instanceId, engine);
    }
    return engine;
  };
  const sent = (instanceId: string) => vi.mocked(engines.get(instanceId)?.generateText)?.mock.calls.length ?? 0;
  // What server/index.ts does on every read of the engines: choose, then let the tests settle the choice.
  const refresh = (read = tested.read()) => {
    pick = tested.settle(selectDefaultModelSelection(instances, saved, { answered: tested.answered, company }), instances, read);
    return pick;
  };
  const make = (extra: Partial<TestedAiDeps> = {}) => createTestedAi({
    engine: (instanceId) => engineFor(instanceId),
    saved: () => [saved, profile],
    hosted: () => false,
    context: { company: (instanceId) => company(instanceId) },
    store: () => store as unknown as ReturnType<TestedAiDeps["store"]>,
    threadBusy: (botId, threadId) => busy.has(`${botId}/${threadId}`),
    forBot: (selection) => ({ ...selection, effort: "high" }),
    changed: async () => refresh(),
    background: true,
    file: join(data, "ai-checks.json"),
    now: () => clock,
    after: (ms, run) => {
      const timer = { at: clock + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    ...extra,
  });
  const settled = () => vi.waitFor(() => expect(tested.testing()).toBe(false));
  /** Time passes: due retries fire, and their tests finish. */
  const wait = async (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= clock) timer.run();
      else timers.push(timer);
    }
    await settled();
  };
  /** First run: read the engines, then make the first bot, as server/index.ts does at start. */
  const boot = async () => {
    refresh();
    tested.seed();
    await settled();
  };
  const chief = () => store.bot("chief")!;

  beforeEach(() => {
    instances = [ready("grok", "grokAgent"), ready("claude", "claudeAgent")];
    answers = { claude: async () => "OK", grok: async () => "OK", opencodeGo: async () => "OK" };
    engines = new Map();
    saved = undefined;
    profile = undefined;
    busy = new Set();
    clock = 1_000_000;
    timers = [];
    company = () => false;
    data = mkdtempSync(join(tmpdir(), "omb-tested-ai-"));
    store = new FakeStore(() => pick);
    tested = make();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(data, { recursive: true, force: true });
  });

  it("picks by ranking at once, tests the pick in the background, and keeps it when it answers", async () => {
    refresh();
    expect(pick).toEqual(on("claude"));
    expect(tested.state(instances[1]!)).toBe("testing");
    tested.seed();
    await settled();
    expect(tested.state(instances[1]!)).toBe("passed");
    expect(sent("claude")).toBe(1);
    expect(sent("grok")).toBe(0);
    expect(pick).toEqual(on("claude"));
    expect(chief().modelSelection).toEqual(on("claude"));
  });

  it("doesn't demote an AI for one missed test: it tries again in two minutes and keeps its place", async () => {
    answers.claude = silent;
    await boot();
    expect(tested.state(instances[1]!)).toBe("failed");
    expect(tested.answered(instances[1]!)).toBeUndefined();
    expect(pick).toEqual(on("claude"));
    expect(sent("grok")).toBe(0);
    answers.claude = async () => "OK";
    await wait(2 * MINUTE);
    expect(sent("claude")).toBe(2);
    expect(tested.state(instances[1]!)).toBe("passed");
    expect(pick).toEqual(on("claude"));
    expect(chief().modelSelection).toEqual(on("claude"));
    expect(store.applyModelDefault).not.toHaveBeenCalled();
  });

  it("after two misses in a row moves the default, and the first bot only once the next AI answered", async () => {
    answers.claude = silent;
    let grokAnswers!: (text: string) => void;
    answers.grok = () => new Promise<string>((resolve) => { grokAnswers = resolve; });
    await boot();
    clock += 2 * MINUTE;
    for (const timer of timers.splice(0)) timer.run();
    await vi.waitFor(() => expect(tested.answered(instances[1]!)).toBe(false));
    expect(tested.state(instances[1]!)).toBe("failed");
    // The default goes to the next AI at once, but the first bot waits for that AI's own answer.
    await vi.waitFor(() => expect(tested.state(instances[0]!)).toBe("testing"));
    expect(pick).toEqual(on("grok"));
    expect(chief().modelSelection).toEqual(on("claude"));
    grokAnswers("OK");
    await settled();
    expect(chief().modelSelection).toEqual({ ...on("grok"), effort: "high" });
  });

  it("keeps the default on the AI that answered while one that didn't is being tried again", async () => {
    instances = [ready("claude", "claudeAgent"), ready("opencodeGo", "opencodeGo", { freeFallback: true })];
    answers.claude = silent;
    await boot();
    await wait(2 * MINUTE);
    expect(pick).toEqual(on("opencodeGo"));
    let claudeAnswers!: (text: string) => void;
    answers.claude = () => new Promise<string>((resolve) => { claudeAnswers = resolve; });
    clock += 10 * MINUTE;
    for (const timer of timers.splice(0)) timer.run();
    await vi.waitFor(() => expect(tested.state(instances[0]!)).toBe("testing"));
    expect(refresh()).toEqual(on("opencodeGo"));
    claudeAnswers("OK");
    await settled();
    expect(pick).toEqual(on("claude"));
    expect(chief().modelSelection.instanceId).toBe("claude");
  });

  it("moves the first bot back once the person's own AI answers again, even after a restart", async () => {
    instances = [ready("claude", "claudeAgent"), ready("opencodeGo", "opencodeGo", { freeFallback: true })];
    answers.claude = silent;
    await boot();
    await wait(2 * MINUTE);
    expect(chief().modelSelection.instanceId).toBe("opencodeGo");
    // The app restarts before Claude's next try; Claude answers then.
    answers.claude = async () => "OK";
    engines = new Map();
    timers = [];
    tested = make();
    refresh();
    tested.seed();
    await settled();
    expect(sent("claude")).toBe(0);
    await wait(10 * MINUTE);
    expect(sent("claude")).toBe(1);
    expect(pick).toEqual(on("claude"));
    expect(chief().modelSelection.instanceId).toBe("claude");
  });

  it("moves the first bot off an AI whose latest test missed, to the default that answered, as the welcome says", async () => {
    answers.claude = silent;
    await boot();
    expect(chief().modelSelection).toEqual(on("claude"));
    // The welcome checks the next AI while Claude waits for its retry; that AI answers, and new bots get it.
    await tested.check({ ...engineFor("grok"), snapshot: async () => instances[0]!.snapshot });
    await settled();
    expect(pick).toEqual(on("grok"));
    expect(chief().modelSelection, "the first bot goes where the welcome said").toEqual({ ...on("grok"), effort: "high" });
    // Claude answers its retry: the first bot, still following, moves back up.
    answers.claude = async () => "OK";
    await wait(2 * MINUTE);
    expect(pick).toEqual(on("claude"));
    expect(chief().modelSelection.instanceId).toBe("claude");
  });

  it("moves the first bot on a result that lands while a later start still reads the engines, once that read settles", async () => {
    answers.claude = silent;
    await boot();
    expect(chief().modelSelection).toEqual(on("claude"));
    // The app restarts mid-welcome; the engines are read one at a time, and nothing settles until that read ends.
    engines = new Map();
    timers = [];
    let reading = true;
    tested = make({ changed: async () => { if (!reading) refresh(); } });
    tested.seed();
    await tested.check({ ...engineFor("grok"), snapshot: async () => instances[0]!.snapshot });
    await settled();
    expect(chief().modelSelection, "nothing moves on the last run's status").toEqual(on("claude"));
    reading = false;
    refresh();
    await settled();
    expect(pick).toEqual(on("grok"));
    expect(chief().modelSelection).toEqual({ ...on("grok"), effort: "high" });
    expect(sent("claude"), "Claude's retry is still two minutes off").toBe(0);
  });

  it("moves the first bot off an AI that can't run once one that can has answered", async () => {
    instances = [ready("claude", "claudeAgent", { authenticated: false })];
    await boot();
    expect(chief().modelSelection.instanceId, "nothing could run: the first bot got what was there").toBe("claude");
    answers.codex = async () => "OK";
    instances = [ready("claude", "claudeAgent", { authenticated: false }), ready("codex", "codex")];
    refresh();
    await settled();
    expect(pick).toEqual(on("codex"));
    expect(chief().modelSelection.instanceId).toBe("codex");
  });

  it("keeps trying an AI that missed three times, once an hour", async () => {
    answers.claude = silent;
    await boot();
    await wait(2 * MINUTE);
    await wait(10 * MINUTE);
    expect(sent("claude")).toBe(3);
    await wait(59 * MINUTE);
    expect(sent("claude"), "not before the hour").toBe(3);
    await wait(MINUTE);
    expect(sent("claude")).toBe(4);
    answers.claude = async () => "OK";
    await wait(60 * MINUTE);
    expect(sent("claude")).toBe(5);
    expect(pick).toEqual(on("claude"));
  });

  it("keeps a passing result across a restart for a day, so a start sends no test message", async () => {
    await boot();
    expect(sent("claude")).toBe(1);
    engines = new Map();
    tested = make();
    refresh();
    await settled();
    expect(sent("claude")).toBe(0);
    expect(tested.state(instances[1]!)).toBe("passed");
    clock += 24 * 60 * MINUTE;
    engines = new Map();
    tested = make();
    refresh();
    await settled();
    expect(sent("claude")).toBe(1);
  });

  it("tests again when the engine's own settings change, as a new key would", async () => {
    let identity = "key-1";
    tested = make({ identity: () => identity });
    await boot();
    identity = "key-2";
    clock += 6 * MINUTE;
    refresh();
    await settled();
    expect(sent("claude")).toBe(2);
    expect(configIdentity({ driver: "claudeAgent", environment: { KEY: "a" } })).not.toBe(configIdentity({ driver: "claudeAgent", environment: { KEY: "b" } }));
    const named = (displayName: string) => ({ driver: "claudeAgent", displayName });
    expect(configIdentity(named("One"))).toBe(configIdentity(named("Two")));
  });

  it("never moves a first bot the person chose a model for, wrote to, or set a conversation's AI on", async () => {
    for (const touch of [
      // The same model at another effort is a choice too (the very same choice again can't be told apart from none).
      () => store.choose("chief", { ...on("claude"), effort: "low" }),
      () => store.choose("chief", on("grok")),
      () => { chief().tasks[0]!.modelSelection = on("claude"); store.emit({ type: "bot", botId: "chief" }); },
      () => store.say("chief-main", "user"),
    ]) {
      rmSync(join(data, "ai-checks.json"), { force: true });
      store = new FakeStore(() => pick);
      engines = new Map();
      timers = [];
      answers.claude = silent;
      tested = make();
      await boot();
      // The app's own greeting is not the person's.
      store.say("chief-main", "bot");
      touch();
      await wait(2 * MINUTE);
      expect(pick).toEqual(on("grok"));
      expect(store.applyModelDefault).not.toHaveBeenCalled();
    }
  });

  it("moves only the first bot the app made: never a Chief someone promoted, one a team setup made, or a busy one", async () => {
    answers.claude = silent;
    await boot();
    store.bots.push({ id: "promoted", chiefOfStaff: true, modelSelection: on("claude"), tasks: [{ threadId: "promoted-main" }] });
    busy.add("chief/chief-main");
    await wait(2 * MINUTE);
    expect(pick).toEqual(on("grok"));
    expect(store.bot("promoted")!.modelSelection).toEqual(on("claude"));
    expect(chief().modelSelection).toEqual(on("claude"));
  });

  it("never moves anything on a status read alone, such as one that timed out", async () => {
    await boot();
    // Claude's status read fails once: the default for new bots reads Grok for that moment, nothing follows it.
    instances = [ready("grok", "grokAgent"), { ...ready("claude", "claudeAgent"), snapshot: { state: "unavailable", reason: "timed out" } }];
    clock += 6 * MINUTE;
    refresh();
    await settled();
    expect(pick).toEqual(on("grok"));
    expect(chief().modelSelection).toEqual(on("claude"));
    expect(store.applyModelDefault).not.toHaveBeenCalled();
  });

  it("never tests or moves a default the person saved, in Settings or as the New Bot defaults' model", async () => {
    for (const keep of [() => { saved = on("claude"); }, () => { profile = on("claude"); }]) {
      saved = undefined;
      profile = undefined;
      keep();
      engines = new Map();
      answers.claude = silent;
      tested = make();
      await boot();
      await wait(10 * MINUTE);
      expect(engines.size).toBe(0);
      expect(store.applyModelDefault).not.toHaveBeenCalled();
    }
  });

  it("tests the person's own AIs in the order the default picks them, and never an organization's or the trial credit", async () => {
    company = (instanceId) => instanceId === "company.claude";
    instances = [ready("company.claude", "claudeAgent"), ready("grok", "grokAgent")];
    await boot();
    expect(sent("grok")).toBe(1);
    expect(sent("company.claude")).toBe(0);
    instances = [ready("company.claude", "claudeAgent")];
    clock += 6 * MINUTE;
    refresh();
    await settled();
    expect(sent("company.claude")).toBe(0);
  });

  it("lets only the latest read of the engines settle anything", async () => {
    await boot();
    const older = tested.read();
    instances = [ready("grok", "grokAgent")];
    expect(refresh()).toEqual(on("grok"));
    await settled();
    const before = engines.size;
    // A slow read that started first finishes last, with an AI nobody has tested: it neither changes the pick nor tests it.
    instances = [ready("claude-work", "claudeAgent"), ready("grok", "grokAgent"), ready("claude", "claudeAgent")];
    expect(refresh(older)).toEqual(on("grok"));
    expect(tested.testing()).toBe(false);
    expect(engines.size).toBe(before);
  });

  it("counts a test that hangs past its time as a miss, and holds nothing open", async () => {
    vi.useFakeTimers();
    tested = make({ timeoutMs: 30_000, after: undefined });
    answers.claude = () => new Promise<string>(() => {});
    refresh();
    expect(tested.state(instances[1]!)).toBe("testing");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tested.state(instances[1]!)).toBe("failed");
    expect(tested.testing()).toBe(false);
    // Only the retry in two minutes is left, and it doesn't keep the process alive.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("tests an AI whose status keeps changing at most once in five minutes in the background", async () => {
    instances = [ready("claude", "claudeAgent")];
    await boot();
    for (const account of [undefined, { email: "person@example.test" }, undefined]) {
      clock += MINUTE;
      instances = [ready("claude", "claudeAgent", account ? { account } : { authenticated: undefined })];
      refresh();
      await settled();
    }
    expect(sent("claude")).toBe(1);
    clock += 5 * MINUTE;
    refresh();
    await settled();
    expect(sent("claude")).toBe(2);
  });

  it("checks one AI on request, sharing a test already under way, and live every other time", async () => {
    const live = { ...engineFor("claude"), snapshot: async () => instances[1]!.snapshot };
    refresh();
    await expect(tested.check(live)).resolves.toEqual({ ok: true });
    expect(sent("claude")).toBe(1);
    expect(tested.info(instances[1]!)).toEqual({ aiTest: "passed" });
    expect(tested.info(instances[0]!)).toEqual({});
    // Check again: a sign-out the last status read hasn't seen yet still shows, with the reason.
    answers.claude = async () => { throw new Error("Not logged in · Please run /login"); };
    await expect(tested.check(live)).resolves.toMatchObject({ ok: false });
    expect(tested.info(instances[1]!)).toEqual({ aiTest: "failed", aiTestError: "claude isn't signed in on this computer anymore. Sign in again, then check again." });
  });

  it("sends nothing in the background where it is switched off, and still checks on request", async () => {
    tested = make({ background: false });
    await boot();
    expect(engines.size).toBe(0);
    await expect(tested.check({ ...engineFor("grok"), snapshot: async () => instances[0]!.snapshot })).resolves.toEqual({ ok: true });
  });

  it("lets the first bot follow while the app fills in its model, when nothing could run at first", async () => {
    instances = [];
    await boot();
    expect(chief().modelSelection).toEqual({ instanceId: "", model: "" });
    // The app gives the waiting bot the default once an AI turns up (refreshUnsetModelSelections).
    instances = [ready("claude", "claudeAgent"), ready("grok", "grokAgent")];
    answers.claude = silent;
    refresh();
    store.choose("chief", pick);
    await settled();
    await wait(2 * MINUTE);
    expect(chief().modelSelection.instanceId).toBe("grok");
  });

  it("writes its record where it was told, and starts clean from a broken one", async () => {
    await boot();
    expect(JSON.parse(readFileSync(join(data, "ai-checks.json"), "utf8"))).toMatchObject({ follower: { botId: "chief" } });
    writeFileSync(join(data, "ai-checks.json"), "{not json");
    engines = new Map();
    tested = make();
    refresh();
    await settled();
    expect(sent("claude")).toBe(1);
  });
});

describe("test messages in the background", () => {
  it("are on unless OMB_AI_CHECKS=0, and under vitest only when a test asks for them, so fake engines log only the turns a test sends", () => {
    expect(backgroundAiChecks({})).toBe(true);
    expect(backgroundAiChecks({ OMB_AI_CHECKS: "0" })).toBe(false);
    expect(backgroundAiChecks({ OMB_AI_CHECKS: " 0 " })).toBe(false);
    expect(backgroundAiChecks({ VITEST: "true" })).toBe(false);
    expect(backgroundAiChecks({ VITEST: "true", OMB_AI_CHECKS: "1" })).toBe(true);
    expect(backgroundAiChecks({ OMB_TEST_SEALED_PATH: "1" })).toBe(false);
    expect(backgroundAiChecks({ OMB_TEST_SEALED_PATH: "1", OMB_AI_CHECKS: "1" })).toBe(true);
  });
});
