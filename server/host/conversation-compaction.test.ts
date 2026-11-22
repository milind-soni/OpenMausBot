import { describe, expect, it } from "vitest";
import { compactBudget } from "../context-budget.ts";
import type { BotRecord, Message } from "../store.ts";
import { claudeCompactionDisabled, createConversationCompaction, foldBackstop, foldDue, type ConversationCompactionDeps } from "./conversation-compaction.ts";

describe("foldBackstop", () => {
  it("sits above where each engine compacts by itself and below its limit", () => {
    // Claude Code with --autocompact 200000 compacts near 167k; with its own window on a 1M model, near 967k.
    expect(foldBackstop(200_000, 200_000)).toBe(190_000);
    expect(foldBackstop(1_000_000, 200_000)).toBe(190_000);
    expect(foldBackstop(1_000_000)).toBe(990_000);
    expect(foldBackstop(200_000, 100_000)).toBe(95_000);
    // Codex compacts at 90% of the window it reports.
    expect(foldBackstop(272_000)).toBeGreaterThan(272_000 * 0.9);
    expect(foldBackstop(272_000)).toBeLessThan(272_000);
    expect(foldBackstop(8_000)).toBe(7_600);
  });
});

describe("foldDue", () => {
  const claude = { engineCompacts: true, estimatedBytes: 0, window: 200_000, nativeCompactAt: 200_000 };

  it("leaves a self-compacting engine's session alone below the backstop, where the fold used to run first", () => {
    expect(compactBudget(200_000, undefined, 200_000)).toBe(160_000);
    for (const contextTokens of [160_000, 164_274, 170_000, 189_999]) expect(foldDue({ ...claude, contextTokens })).toBe(false);
  });

  it("folds a session its engine left uncompacted", () => {
    expect(foldDue({ ...claude, contextTokens: 190_000 })).toBe(true);
    expect(foldDue({ engineCompacts: true, estimatedBytes: 0, window: 1_000_000, contextTokens: 989_999 })).toBe(false);
    expect(foldDue({ engineCompacts: true, estimatedBytes: 0, window: 1_000_000, contextTokens: 990_000 })).toBe(true);
  });

  it("never folds a self-compacting engine's session on a transcript estimate, which is not what its session holds", () => {
    expect(foldDue({ ...claude, estimatedBytes: 4_000_000 })).toBe(false);
    expect(foldDue({ ...claude, estimatedBytes: 4_000_000, idleFraction: 0.85 })).toBe(false);
  });

  it("keeps the fold where it was for an engine that does not compact itself", () => {
    const fed = { engineCompacts: false, estimatedBytes: 0, window: 200_000 };
    expect(foldDue({ ...fed, contextTokens: 159_999 })).toBe(false);
    expect(foldDue({ ...fed, contextTokens: 160_000 })).toBe(true);
    expect(foldDue({ ...fed, estimatedBytes: 640_000 })).toBe(true);
    expect(foldDue({ ...fed, contextTokens: 136_000, idleFraction: 0.85 })).toBe(true);
    expect(foldDue({ ...fed, contextTokens: 135_999, idleFraction: 0.85 })).toBe(false);
  });

  it("keeps the fold where it was for Claude Code with its own compaction switched off", () => {
    expect(foldDue({ engineCompacts: false, estimatedBytes: 0, window: 200_000, nativeCompactAt: 200_000, contextTokens: 160_000 })).toBe(true);
  });

  it("honours a compactAt the person set, for every engine", () => {
    expect(foldDue({ ...claude, configuredCompactAt: 0.5, contextTokens: 99_999 })).toBe(false);
    expect(foldDue({ ...claude, configuredCompactAt: 0.5, contextTokens: 100_000 })).toBe(true);
    expect(foldDue({ ...claude, configuredCompactAt: 120_000, contextTokens: 120_000 })).toBe(true);
    // Still never past the engine's own point.
    expect(foldDue({ ...claude, configuredCompactAt: 0.99, contextTokens: 180_000 })).toBe(true);
  });
});

describe("claudeCompactionDisabled", () => {
  it("reads Claude Code's own switches", () => {
    expect(claudeCompactionDisabled({})).toBe(false);
    expect(claudeCompactionDisabled({ DISABLE_AUTO_COMPACT: "1" })).toBe(true);
    expect(claudeCompactionDisabled({ DISABLE_COMPACT: "true" })).toBe(true);
    expect(claudeCompactionDisabled({ DISABLE_AUTO_COMPACT: "0", DISABLE_COMPACT: "" })).toBe(false);
  });
});

describe("compactConversation", () => {
  const bot = { id: "bot" } as BotRecord;
  const thread = "thread";
  function setup(options: { tokens: number; nativeCompaction?: boolean; engineCompactionOn?: boolean; engineCompact?: boolean | "stale"; compactAt?: number;
    generateText?: ConversationCompactionDeps["generateText"]; claimIsCurrent?: () => boolean; resumes?: boolean; applied?: string }) {
    const messages: Message[] = ["one", "two", "three", "four"].flatMap((word, index) => [
      { id: `u${index}`, role: "user", kind: "text", text: `ask ${word}`, at: index * 2 } as Message,
      { id: `b${index}`, role: "bot", kind: "text", text: `answer ${word}`, at: index * 2 + 1 } as Message,
    ]);
    const asked: string[] = [];
    const checks: Array<{ model: string; compactAtSet: boolean; resumes: boolean; current: boolean; selection: { instanceId: string; model: string | null } | undefined }> = [];
    const summarizing: boolean[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const deps: ConversationCompactionDeps = {
      store: {
        taskByThread: () => ({ lastContextModel: "engine:model", usage: { context: { tokens: options.tokens, window: 200_000 } }, resumeCursors: {}, appliedCompactionId: options.applied }) as never,
        activePath: () => messages,
        patchTask: (_botId: string, _threadId: string, patch: Record<string, unknown>) => { patches.push(patch); return undefined as never; },
        appendMessage: (_threadId: string, message: Partial<Message>) => { const made = { id: `m${messages.length}`, ...message } as Message; messages.push(made); return made; },
      } as never,
      context: () => (options.compactAt === undefined ? undefined : { compactAt: options.compactAt }),
      directContext: (_bot, _thread, all) => all.filter((m) => m.kind === "text").map((m) => ({ id: m.id, role: m.role === "user" ? "user" as const : "assistant" as const, text: m.text ?? "" })),
      latestCompaction: () => (options.applied ? { id: options.applied } : undefined) as never,
      nativeCompactTokens: () => 200_000,
      engineCompactionOn: () => options.engineCompactionOn ?? true,
      engineCompact: async (target, _signal, check) => {
        asked.push(target.instanceId);
        checks.push({ model: check.model, compactAtSet: check.compactAtSet, resumes: check.resumes("session-1"), current: check.current(), selection: check.selectionNow() });
        return options.engineCompact === "stale" ? "stale" : options.engineCompact ? "done" : "skipped";
      },
      resumesSession: () => options.resumes ?? true,
      currentSelection: () => ({ instanceId: "engine", model: "model" }),
      generateText: options.generateText ?? (() => undefined),
      claimIsCurrent: options.claimIsCurrent ?? (() => true),
      controllers: new Map(),
      cancelled: (reason) => new Error(reason),
      idleFraction: 0.85,
      summarizing: (threadId, active) => { if (threadId === thread) summarizing.push(active); },
    };
    const instance = { instanceId: "engine", driverKind: "claudeAgent", adapter: { capabilities: { nativeCompaction: options.nativeCompaction ?? true } } };
    const run = (manual: boolean) => createConversationCompaction(deps)({ bot, threadId: thread, generation: "g", instance, model: "model", excludedIds: new Set(), manual });
    const folds = () => messages.filter((m) => m.kind === "compaction");
    return { run, folds, asked, checks, deps, summarizing, patches };
  }

  it("writes no fold before a turn at 164k on an engine that compacts itself, and one on an engine that does not", async () => {
    const own = setup({ tokens: 164_274 });
    await own.run(false);
    expect(own.folds()).toHaveLength(0);
    const fed = setup({ tokens: 164_274, nativeCompaction: false });
    await fed.run(false);
    expect(fed.folds()).toHaveLength(1);
    expect(fed.folds()[0]!.compaction).toMatchObject({ by: "harness", tokensBefore: 164_274 });
  });

  it("folds a session that reached the backstop: its engine did not compact", async () => {
    const stuck = setup({ tokens: 191_000 });
    await stuck.run(false);
    expect(stuck.folds()).toHaveLength(1);
    expect(stuck.asked).toEqual([]);
  });

  it("folds at the usual point when the engine's own compaction is switched off", async () => {
    const off = setup({ tokens: 164_274, engineCompactionOn: false });
    await off.run(false);
    expect(off.folds()).toHaveLength(1);
  });

  it("Compact now asks the engine first and writes no fold of its own when the engine did it", async () => {
    const done = setup({ tokens: 50_000, engineCompact: true });
    await done.run(true);
    expect(done.asked).toEqual(["engine"]);
    expect(done.folds()).toHaveLength(0);
    expect(done.deps.controllers.size).toBe(0);
  });

  it("Compact now falls back to the fold when the engine has no compaction to offer, and never asks an engine without one", async () => {
    const refused = setup({ tokens: 50_000, engineCompact: false });
    await refused.run(true);
    expect(refused.asked).toEqual(["engine"]);
    expect(refused.folds()).toHaveLength(1);
    expect(refused.folds()[0]!.compaction).toMatchObject({ by: "person" });
    const fed = setup({ tokens: 50_000, nativeCompaction: false, engineCompact: true });
    await fed.run(true);
    expect(fed.asked).toEqual([]);
    expect(fed.folds()).toHaveLength(1);
  });
  it("asks the engine with what its compaction is checked against, and folds nothing when the engine compacted but the conversation moved on", async () => {
    const stale = setup({ tokens: 50_000, engineCompact: "stale", resumes: false });
    await stale.run(true);
    expect(stale.asked).toEqual(["engine"]);
    expect(stale.checks).toEqual([{ model: "model", compactAtSet: false, resumes: false, current: true, selection: { instanceId: "engine", model: "model" } }]);
    expect(stale.folds()).toHaveLength(0);
    expect(stale.summarizing).toEqual([]);
    const gone = setup({ tokens: 50_000, engineCompact: "stale", claimIsCurrent: () => false });
    await gone.run(true);
    expect(gone.folds()).toHaveLength(0);
    expect(gone.checks[0]).toMatchObject({ current: false });
    const set = setup({ tokens: 50_000, compactAt: 3_000, engineCompact: "stale" });
    await set.run(true);
    expect(set.checks[0]).toMatchObject({ compactAtSet: true });
  });

  describe("the floor an applied fold leaves", () => {
    const applied = { applied: "rec" };

    it("is written for an automatic check as it always was", async () => {
      const auto = setup({ tokens: 50_000, ...applied });
      await auto.run(false);
      expect(auto.patches).toEqual([{ contextFloor: 50_000 }]);
    });

    it("is written for Compact now only once it goes on to fold, not when the engine compacted or the conversation moved on", async () => {
      for (const engineCompact of [true, "stale"] as const) {
        const engine = setup({ tokens: 50_000, engineCompact, ...applied });
        await engine.run(true);
        expect(engine.patches).toEqual([]);
      }
      const folded = setup({ tokens: 50_000, ...applied });
      await folded.run(true);
      expect(folded.patches).toEqual([{ contextFloor: 50_000 }]);
    });
  });

  it("says it is summarizing while a summary someone waits on is written, and clears it on every way out", async () => {
    const written = setup({ tokens: 50_000 });
    await written.run(true);
    expect(written.folds()).toHaveLength(1);
    expect(written.summarizing).toEqual([true, false]);

    const stopped = setup({ tokens: 164_274, nativeCompaction: false, claimIsCurrent: () => false });
    await expect(stopped.run(false)).rejects.toThrow("context summarization stopped");
    expect(stopped.folds()).toHaveLength(0);
    expect(stopped.summarizing).toEqual([true, false]);

    let started: () => void = () => {};
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const aborted = setup({ tokens: 50_000, nativeCompaction: false,
      generateText: () => (_prompt, options) => new Promise<string>((_resolve, reject) => {
        started();
        options?.signal?.addEventListener("abort", () => reject(options?.signal?.reason), { once: true });
      }) });
    const pending = aborted.run(true);
    await begun;
    expect(aborted.summarizing).toEqual([true]);
    aborted.deps.controllers.get(thread)!.controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(aborted.folds()).toHaveLength(0);
    expect(aborted.summarizing).toEqual([true, false]);
    expect(aborted.deps.controllers.size).toBe(0);
  });

  it("never shows the summarizing line for a session left to its engine, or for an idle summary", async () => {
    const own = setup({ tokens: 164_274 });
    await own.run(false);
    expect(own.summarizing).toEqual([]);
    const done = setup({ tokens: 50_000, engineCompact: true });
    await done.run(true);
    expect(done.summarizing).toEqual([]);
  });
});
