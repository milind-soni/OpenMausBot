import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, loadConfig, parseConfigPatch, parseStoredConfig } from "./config.ts";
import type { TextGenerationOptions } from "./contracts.ts";
import { createMemoryUpkeep, NO_TEXT_ENGINE, type UpkeepBot } from "./memory-upkeep.ts";
import { closeMessageDb } from "./message-db.ts";
import { createSideJobs, helperSelection, type SideJobBot, type SideJobInstance, type SideJobsDeps } from "./side-jobs.ts";
import { ensureWorkspace, workspaceDir, WORKSPACES_DIR } from "./workspace.ts";

type Booked = { row: Parameters<SideJobsDeps["book"]>[0]; tokensReported: boolean; notificationThreadId: string };
type Call = { prompt: string; options?: TextGenerationOptions };

/** An engine with a one-off text call (Claude, an API model), reporting
 * usage the way those drivers do. */
function textEngine(instanceId: string, driverKind: string, reply: (prompt: string) => Promise<string> | string = () => `${instanceId} wrote this`) {
  const calls: Call[] = [];
  const instance: SideJobInstance = {
    instanceId,
    driverKind,
    enabled: true,
    adapter: { capabilities: { agentsMcp: true } },
    generateText: async (prompt, options) => {
      calls.push({ prompt, options });
      const text = await reply(prompt);
      options?.onUsage?.({ model: options.model ?? `${instanceId}-small`, input: 120, output: 30, costUsd: 0.002 });
      return text;
    },
  };
  return { instance, calls };
}

/** Pi or Muse Code: turns only, no one-off text call of any kind. */
const turnsOnly = (instanceId: string, driverKind: string, agentsMcp = true): SideJobInstance =>
  ({ instanceId, driverKind, enabled: true, adapter: { capabilities: { agentsMcp } } });

/** Codex or an ACP engine: its only one-off call is the background one,
 * a whole agent process per call. */
function backgroundEngine(instanceId: string, driverKind: string) {
  const calls: Call[] = [];
  const instance: SideJobInstance = {
    instanceId,
    driverKind,
    enabled: true,
    adapter: { capabilities: { agentsMcp: true } },
    generateMemoryText: async (prompt, options) => {
      calls.push({ prompt, options });
      options?.onUsage?.({ model: `${instanceId}-own`, input: 40, output: 10 });
      return `${instanceId}'s own engine wrote this`;
    },
  };
  return { instance, calls };
}

const bot = (id: string, instanceId: string): SideJobBot => ({ id, name: `Bot ${id}`, threadId: `main-${id}`, modelSelection: { instanceId } });

function setup(options: { helper?: { instanceId: string; model?: string } | null; modelAllowed?: SideJobsDeps["modelAllowed"]; smallModels?: SideJobsDeps["smallModels"] } = {}) {
  const claude = textEngine("claude", "claudeAgent");
  const openrouter = textEngine("openrouter", "openai-compat");
  const acp = backgroundEngine("grok", "grokAgent");
  const codex = backgroundEngine("codex", "codex");
  const state = {
    helper: options.helper === undefined ? { instanceId: "claude" } : options.helper,
    instances: new Map<string, SideJobInstance>([
      ["claude", claude.instance],
      ["openrouter", openrouter.instance],
      ["grok", acp.instance],
      ["codex", codex.instance],
      ["pi", turnsOnly("pi", "piAgent")],
      ["muse", turnsOnly("muse", "museCode")],
    ]),
    bots: new Map<string, SideJobBot>(["claude", "openrouter", "grok", "codex", "pi", "muse"].map((id) => [id, bot(id, id)])),
    refused: new Set<string>(),
    overBudget: false,
    booked: [] as Booked[],
    logs: [] as string[],
  };
  const jobs = createSideJobs({
    bot: (id) => state.bots.get(id),
    instance: (id) => state.instances.get(id) ?? null,
    refusal: (instance) => (state.refused.has(instance.instanceId) ? "the organisation does not allow this engine" : undefined),
    helper: () => state.helper,
    ...(options.modelAllowed ? { modelAllowed: options.modelAllowed } : {}),
    smallModels: options.smallModels ?? { refused: () => new Set(), remember: () => {} },
    assertWithinBudget: () => {
      if (state.overBudget) throw new Error("this workspace has reached its monthly spend limit");
    },
    book: (row, tokensReported, notificationThreadId) => state.booked.push({ row, tokensReported, notificationThreadId }),
    log: (line) => state.logs.push(line),
  });
  return { jobs, state, claude, openrouter, acp, codex };
}

describe("the helper setting", () => {
  const file = join(DATA_DIR, "config.json");
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(file, { force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(file, { force: true });
  });

  it("is unset by default, and needs an instance before a model means anything", () => {
    expect(helperSelection({})).toBeNull();
    expect(helperSelection({ helper: {} })).toBeNull();
    expect(helperSelection({ helper: { instanceId: "  " } })).toBeNull();
    expect(helperSelection({ helper: { model: "claude-haiku-4-5" } })).toBeNull();
    expect(helperSelection({ helper: { instanceId: " claude " } })).toEqual({ instanceId: "claude" });
    expect(helperSelection({ helper: { instanceId: "openrouter", model: " openai/gpt-5.4-mini " } })).toEqual({ instanceId: "openrouter", model: "openai/gpt-5.4-mini" });
  });

  it("is off altogether when its model could not be a model id, rather than quietly using another model", () => {
    // a model id reaches a CLI's argument list, so it never starts with a dash or holds a space
    for (const model of ["--dangerously-skip-permissions", "two words", "line\nbreak"]) {
      expect(helperSelection({ helper: { instanceId: "claude", model } }), model).toBeNull();
    }
  });

  it("is read from config.json, with OMB_HELPER_INSTANCE and OMB_HELPER_MODEL winning", () => {
    expect(helperSelection(loadConfig())).toBeNull();
    writeFileSync(file, JSON.stringify({ helper: { instanceId: "claude", model: "claude-haiku-4-5" } }));
    expect(helperSelection(loadConfig())).toEqual({ instanceId: "claude", model: "claude-haiku-4-5" });
    vi.stubEnv("OMB_HELPER_INSTANCE", "openrouter");
    vi.stubEnv("OMB_HELPER_MODEL", "openai/gpt-5.4-mini");
    expect(helperSelection(loadConfig())).toEqual({ instanceId: "openrouter", model: "openai/gpt-5.4-mini" });
    // an empty value switches a saved helper off without editing the file
    vi.stubEnv("OMB_HELPER_INSTANCE", "");
    expect(helperSelection(loadConfig())).toBeNull();
  });

  it("can be set from the environment alone", () => {
    vi.stubEnv("OMB_HELPER_INSTANCE", "claude");
    expect(helperSelection(loadConfig())).toEqual({ instanceId: "claude" });
    expect(helperSelection({}, { OMB_HELPER_INSTANCE: "openrouter", OMB_HELPER_MODEL: "openai/gpt-5.4-mini" })).toEqual({ instanceId: "openrouter", model: "openai/gpt-5.4-mini" });
    // a model alone names no helper, and a model that could not be a model id switches it off, from the environment too
    expect(helperSelection({}, { OMB_HELPER_MODEL: "claude-haiku-4-5" })).toBeNull();
    expect(helperSelection({ helper: { instanceId: "claude" } }, { OMB_HELPER_MODEL: "--print" })).toBeNull();
  });

  it("is not something a settings request can switch on, and a mistyped entry never costs the rest of the file", () => {
    expect(parseConfigPatch({ helper: { instanceId: "claude" }, language: "en" })).toEqual({ language: "en" });
    expect(parseStoredConfig({ helper: { instanceId: "claude" } })).toEqual({ helper: { instanceId: "claude" } });
    expect(parseStoredConfig({ helper: "claude", language: "en" })).toEqual({ language: "en" });
    expect(parseStoredConfig({ helper: { instanceId: 7 }, language: "en" })).toEqual({ language: "en" });
  });
});

describe("who writes a small job", () => {
  it("is the bot's own engine whenever it can: the helper is never called", async () => {
    const { jobs, state, claude, openrouter } = setup({ helper: { instanceId: "openrouter" } });
    for (const job of ["compaction", "memory", "skill-review"] as const) {
      const text = jobs.text(job, "claude");
      expect(text?.via, job).toBe("engine");
      expect(await text!.generateText(`${job} prompt`)).toBe("claude wrote this");
    }
    expect(claude.calls.map((call) => call.prompt)).toEqual(["compaction prompt", "memory prompt", "skill-review prompt"]);
    expect(openrouter.calls).toEqual([]);
    expect(state.booked.every((entry) => entry.row.instanceId === "claude")).toBe(true);
  });

  it("is the helper for an engine with no text call, Pi and Muse Code alike", async () => {
    const { jobs, claude } = setup();
    for (const botId of ["pi", "muse"]) {
      for (const job of ["compaction", "memory", "skill-review"] as const) {
        const text = jobs.text(job, botId);
        expect(text?.via, `${botId} ${job}`).toBe("helper");
        expect(await text!.generateText(`${botId} ${job}`)).toBe("claude wrote this");
      }
    }
    expect(claude.calls).toHaveLength(6);
  });

  it("is nobody when no helper is set: the job keeps the fallback it has today", () => {
    const { jobs, state } = setup({ helper: null });
    for (const job of ["compaction", "memory", "skill-review"] as const) {
      expect(jobs.text(job, "pi"), job).toBeNull();
      expect(jobs.text(job, "muse"), job).toBeNull();
    }
    expect(state.logs).toEqual([]);
  });

  it.each(["grok", "codex"] as const)("gives %s the helper for the compaction summary only: its own background call keeps memory upkeep and the skill review", async (botId) => {
    const all = setup();
    const { jobs, claude } = all;
    const own = botId === "grok" ? all.acp : all.codex;
    expect(jobs.text("memory", botId)?.via).toBe("engine");
    expect(jobs.text("skill-review", botId)?.via).toBe("engine");
    expect(await jobs.text("memory", botId)!.generateText("memory prompt")).toBe(`${botId}'s own engine wrote this`);
    expect(own.calls.map((call) => call.prompt)).toEqual(["memory prompt"]);
    expect(claude.calls).toEqual([]);
    // that call starts a whole agent process, so the summary a turn waits for never uses it
    const summary = jobs.text("compaction", botId);
    expect(summary?.via).toBe("helper");
    await summary!.generateText("summary prompt");
    expect(own.calls).toHaveLength(1);
    expect(claude.calls.map((call) => call.prompt)).toEqual(["summary prompt"]);
    expect(setup({ helper: null }).jobs.text("compaction", botId)).toBeNull();
  });

  it("uses the engine a conversation is running on for its summary, when that is not the bot's default", async () => {
    const { jobs, state, claude, openrouter } = setup({ helper: { instanceId: "openrouter" } });
    // the bot's default is Pi, this conversation runs on Claude
    const own = jobs.text("compaction", "pi", { instance: state.instances.get("claude")! });
    expect(own?.via).toBe("engine");
    await own!.generateText("summary");
    expect(claude.calls).toHaveLength(1);
    expect(openrouter.calls).toEqual([]);
  });

  it("asks the helper for the model the setting names, and for its own default otherwise", async () => {
    const named = setup({ helper: { instanceId: "openrouter", model: "openai/gpt-5.4-mini" } });
    await named.jobs.text("memory", "pi")!.generateText("p");
    expect(named.openrouter.calls[0]!.options?.model).toBe("openai/gpt-5.4-mini");
    expect(named.state.booked[0]!.row.model).toBe("openai/gpt-5.4-mini");

    const unnamed = setup();
    await unnamed.jobs.text("memory", "pi")!.generateText("p");
    expect(unnamed.claude.calls[0]!.options).not.toHaveProperty("model");
    expect(unnamed.state.booked[0]!.row.model).toBe("claude-small");
  });

  it("passes the job's own stop signal through to whoever writes", async () => {
    const { jobs, claude } = setup();
    const controller = new AbortController();
    await jobs.text("memory", "pi")!.generateText("p", { signal: controller.signal });
    expect(claude.calls[0]!.options?.signal).toBe(controller.signal);
  });
});

describe("the small model a bot's own engine writes on", () => {
  const refusals = () => {
    const refused = new Map<string, Set<string>>();
    return {
      refused: (instanceId: string): ReadonlySet<string> => refused.get(instanceId) ?? new Set(),
      remember: (instanceId: string, model: string) => { refused.set(instanceId, new Set([...refused.get(instanceId) ?? [], model])); },
    };
  };

  it("comes with the bot's own model and the small models its engine refused, read at every call", async () => {
    const smallModels = refusals();
    const { jobs, state, codex } = setup({ smallModels });
    state.bots.set("codex", { ...bot("codex", "codex"), modelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
    const memory = jobs.text("memory", "codex")!;
    await memory.generateText("first");
    codex.calls[0]!.options!.fallback!.onRefused("gpt-5.4-mini");
    await memory.generateText("second");
    expect(codex.calls.map((call) => call.options?.fallback)).toEqual([
      expect.objectContaining({ model: "gpt-6-astra", refused: new Set() }),
      expect.objectContaining({ model: "gpt-6-astra", refused: new Set(["gpt-5.4-mini"]) }),
    ]);
    expect(smallModels.refused("codex")).toEqual(new Set(["gpt-5.4-mini"]));
    expect(state.logs).toContain("small model gpt-5.4-mini refused on codex: background text runs on the bot's own model");
  });

  it("names no model of the bot's on another engine, and is never sent to a helper", async () => {
    const { jobs, state, claude, codex } = setup({ smallModels: refusals() });
    state.bots.set("pi", { ...bot("pi", "pi"), modelSelection: { instanceId: "pi", model: "pi-large" } });
    await jobs.text("memory", "pi", { instance: state.instances.get("codex")! })!.generateText("p");
    expect(codex.calls[0]!.options?.fallback).not.toHaveProperty("model");
    await jobs.text("memory", "pi")!.generateText("p");
    expect(claude.calls[0]!.options).not.toHaveProperty("fallback");
  });
});

describe("what a helper call is booked as", () => {
  it("is its own usage row: the bot it was for, the helper's instance and model, and a trigger that says helper", async () => {
    const { jobs, state } = setup();
    await jobs.text("memory", "pi")!.generateText("p");
    await jobs.text("compaction", "codex")!.generateText("p");
    await jobs.text("skill-review", "muse")!.generateText("p");
    expect(state.booked.map((entry) => entry.row)).toEqual([
      expect.objectContaining({ botId: "pi", botName: "Bot pi", instanceId: "claude", driverKind: "claudeAgent", model: "claude-small", input: 120, output: 30, costUsd: 0.002, trigger: { kind: "helper", botId: "pi", job: "memory" } }),
      expect.objectContaining({ botId: "codex", instanceId: "claude", trigger: { kind: "helper", botId: "codex", job: "compaction" } }),
      expect.objectContaining({ botId: "muse", instanceId: "claude", trigger: { kind: "helper", botId: "muse", job: "skill-review" } }),
    ]);
    // one row per call, never two calls under one key
    expect(state.booked.map((entry) => entry.row.threadId)).toEqual([
      expect.stringMatching(/^memory-[0-9a-f-]{36}$/),
      expect.stringMatching(/^compaction-[0-9a-f-]{36}$/),
      expect.stringMatching(/^skill-review-[0-9a-f-]{36}$/),
    ]);
    expect(new Set(state.booked.map((entry) => entry.row.threadId)).size).toBe(3);
    // a spend alert lands in the bot's main conversation, as for its own background calls
    expect(state.booked.map((entry) => entry.notificationThreadId)).toEqual(["main-pi", "main-codex", "main-muse"]);
    expect(state.booked.every((entry) => entry.tokensReported)).toBe(true);
  });

  it("books a helper that reports no tokens as unpriced, not as a free call", async () => {
    const { jobs, state } = setup();
    state.instances.set("claude", { ...state.instances.get("claude")!, generateText: async (_prompt, options) => {
      options?.onUsage?.({ model: "claude-small" });
      return "text";
    } });
    await jobs.text("memory", "pi")!.generateText("p");
    expect(state.booked[0]).toMatchObject({ row: { input: 0, output: 0, costUsd: null }, tokensReported: false });
  });

  it("leaves the bot's own background calls booked as they were, and its own summary unbooked", async () => {
    const { jobs, state } = setup();
    await jobs.text("memory", "claude")!.generateText("p");
    await jobs.text("skill-review", "claude")!.generateText("p");
    await jobs.text("compaction", "claude")!.generateText("p");
    await jobs.text("memory", "codex")!.generateText("p");
    expect(state.booked.map((entry) => entry.row)).toEqual([
      expect.objectContaining({ botId: "claude", instanceId: "claude", driverKind: "claudeAgent", threadId: expect.stringMatching(/^memory-/), trigger: { kind: "bot", botId: "claude" } }),
      expect.objectContaining({ botId: "claude", instanceId: "claude", threadId: expect.stringMatching(/^skill-review-/), trigger: { kind: "bot", botId: "claude" } }),
      expect.objectContaining({ botId: "codex", instanceId: "codex", driverKind: "codex", model: "codex-own", threadId: expect.stringMatching(/^memory-/), trigger: { kind: "bot", botId: "codex" } }),
    ]);
  });

  it("makes no call for a workspace at its spend limit, on the helper as on the bot's own background calls", async () => {
    const { jobs, state, claude } = setup();
    state.overBudget = true;
    await expect(jobs.text("memory", "pi")!.generateText("p")).rejects.toThrow("monthly spend limit");
    await expect(jobs.text("compaction", "codex")!.generateText("p")).rejects.toThrow("monthly spend limit");
    await expect(jobs.text("memory", "claude")!.generateText("p")).rejects.toThrow("monthly spend limit");
    expect(claude.calls).toEqual([]);
    expect(state.booked).toEqual([]);
  });
});

describe("when the helper is not used", () => {
  it("never takes over from a bot whose own engine is missing or disallowed", () => {
    const { jobs, state } = setup();
    state.refused.add("muse");
    state.refused.add("codex");
    state.instances.delete("pi");
    for (const job of ["compaction", "memory", "skill-review"] as const) {
      expect(jobs.text(job, "muse"), job).toBeNull();
      expect(jobs.text(job, "codex"), job).toBeNull();
      expect(jobs.text(job, "pi"), job).toBeNull();
      expect(jobs.text(job, "no-such-bot"), job).toBeNull();
    }
  });

  it("is never an engine the organisation does not allow", async () => {
    const { jobs, state, claude } = setup();
    state.refused.add("claude");
    for (const job of ["compaction", "memory", "skill-review"] as const) expect(jobs.text(job, "pi"), job).toBeNull();
    expect(jobs.text("compaction", "codex")).toBeNull();
    expect(claude.calls).toEqual([]);
    expect(state.logs).toEqual([expect.stringContaining("the organisation does not allow this engine")]);
  });

  it("is never a model a hosted workspace has not been assigned", () => {
    const assigned = (selection: { instanceId: string; model: string }) => selection.instanceId === "claude" && selection.model === "company-haiku";
    expect(setup({ helper: { instanceId: "claude", model: "claude-opus-5-5" }, modelAllowed: assigned }).jobs.text("memory", "pi")).toBeNull();
    expect(setup({ helper: { instanceId: "claude", model: "company-haiku" }, modelAllowed: assigned }).jobs.text("memory", "pi")?.via).toBe("helper");
    // with no model named the instance uses its own default, which a hosted workspace already limits
    expect(setup({ helper: { instanceId: "claude" }, modelAllowed: assigned }).jobs.text("memory", "pi")?.via).toBe("helper");
  });

  it("is skipped when the instance is not connected, switched off, or has no one-off text call of its own", () => {
    const missing = setup({ helper: { instanceId: "gone" } });
    expect(missing.jobs.text("memory", "pi")).toBeNull();
    expect(missing.state.logs).toEqual([expect.stringContaining('"gone" is not connected')]);

    const off = setup();
    off.state.instances.set("claude", { ...off.state.instances.get("claude")!, enabled: false });
    expect(off.jobs.text("memory", "pi")).toBeNull();

    // Codex's or an ACP engine's background call starts a whole agent process: it serves its own bots only
    for (const instanceId of ["muse", "codex", "grok"]) {
      const unable = setup({ helper: { instanceId } });
      expect(unable.jobs.text("memory", "pi"), instanceId).toBeNull();
      expect(unable.jobs.text("compaction", "pi"), instanceId).toBeNull();
      expect(unable.state.logs).toEqual([expect.stringContaining("cannot make a one-off text call")]);
    }
  });

  it("reads a helper that cannot even be looked up as no helper: nothing is thrown at the job, and it is said once", () => {
    const broken = (deps: Partial<SideJobsDeps>) => {
      const logs: string[] = [];
      const claude = textEngine("claude", "claudeAgent");
      const engines: Record<string, SideJobInstance> = { claude: claude.instance, pi: turnsOnly("pi", "piAgent") };
      const jobs = createSideJobs({
        bot: (id) => bot(id, id),
        instance: (id) => engines[id] ?? null,
        refusal: () => undefined,
        helper: () => ({ instanceId: "claude" }),
        smallModels: { refused: () => new Set(), remember: () => {} },
        assertWithinBudget: () => {},
        book: () => {},
        log: (line) => logs.push(line),
        ...deps,
      });
      return { jobs, logs, claude };
    };
    const lookups = {
      "the setting": broken({ helper: () => { throw new Error("config.json could not be read"); } }),
      "the instance": broken({ instance: (id) => { if (id === "claude") throw new Error("the registry is reloading"); return turnsOnly("pi", "piAgent"); } }),
      "the policy": broken({ refusal: (instance) => { if (instance.instanceId === "claude") throw new Error("the policy could not be read"); return undefined; } }),
      "the hosted list": broken({ helper: () => ({ instanceId: "claude", model: "m" }), modelAllowed: () => { throw new Error("no catalog"); } }),
    };
    for (const [what, { jobs, logs, claude }] of Object.entries(lookups)) {
      for (let i = 0; i < 3; i += 1) {
        for (const job of ["compaction", "memory", "skill-review"] as const) expect(jobs.text(job, "pi"), `${what} ${job}`).toBeNull();
      }
      expect(logs, what).toHaveLength(1);
      expect(logs[0], what).toContain("could not be looked up");
      expect(claude.calls, what).toEqual([]);
    }
  });

  it("says where the text goes, or why it does not, once per change rather than on every call", () => {
    const { jobs, state } = setup({ helper: { instanceId: "gone" } });
    for (let i = 0; i < 5; i += 1) jobs.text("memory", "pi");
    expect(state.logs).toHaveLength(1);
    state.helper = { instanceId: "claude", model: "claude-haiku-4-5" };
    for (let i = 0; i < 5; i += 1) expect(jobs.text("memory", "pi")?.via).toBe("helper");
    state.helper = { instanceId: "gone" };
    jobs.text("memory", "pi");
    expect(state.logs).toEqual([
      expect.stringContaining('"gone" is not connected'),
      expect.stringContaining('are written by "claude" (claude-haiku-4-5)'),
      expect.stringContaining('"gone" is not connected'),
    ]);
    // a bot whose own engine writes says nothing
    const quiet = setup();
    quiet.jobs.text("memory", "claude");
    expect(quiet.state.logs).toEqual([]);
  });

  it("never writes for a bot switched to never use the helper, for any of the three jobs, as if none were set", async () => {
    const { jobs, state, claude } = setup();
    // Pi has no text call at all; Codex has none for the summary
    state.bots.set("pi", { ...bot("pi", "pi"), helperModel: false });
    state.bots.set("codex", { ...bot("codex", "codex"), helperModel: false });
    for (const job of ["compaction", "memory", "skill-review"] as const) expect(jobs.text(job, "pi"), job).toBeNull();
    expect(jobs.text("compaction", "codex")).toBeNull();
    // nothing was asked of the helper, and nothing is said about it either
    expect(claude.calls).toEqual([]);
    expect(state.booked).toEqual([]);
    expect(state.logs).toEqual([]);

    // a bot without the switch still gets the helper, beside it
    for (const job of ["compaction", "memory", "skill-review"] as const) expect(jobs.text(job, "muse")?.via, job).toBe("helper");
    // and switching it back on is all it takes
    state.bots.set("pi", { ...bot("pi", "pi"), helperModel: true });
    expect(jobs.text("memory", "pi")?.via).toBe("helper");
  });

  it("reads anything but an absent switch or a strict true as never: a hand-edited record fails closed", () => {
    const { jobs, state, claude } = setup();
    for (const odd of ["false", "true", 0, 1, null, {}, []]) {
      state.bots.set("pi", { ...bot("pi", "pi"), helperModel: odd as unknown as boolean });
      for (const job of ["compaction", "memory", "skill-review"] as const) expect(jobs.text(job, "pi"), `${JSON.stringify(odd)} ${job}`).toBeNull();
    }
    expect(claude.calls).toEqual([]);
    expect(state.logs).toEqual([]);
    // absent and true are the only two that allow it
    state.bots.set("pi", bot("pi", "pi"));
    expect(jobs.text("memory", "pi")?.via).toBe("helper");
    state.bots.set("pi", { ...bot("pi", "pi"), helperModel: true });
    expect(jobs.text("memory", "pi")?.via).toBe("helper");
  });

  it("leaves a bot's own engine writing when the bot is switched to never use the helper", async () => {
    const { jobs, state, claude, codex, openrouter } = setup({ helper: { instanceId: "openrouter" } });
    state.bots.set("claude", { ...bot("claude", "claude"), helperModel: false });
    state.bots.set("codex", { ...bot("codex", "codex"), helperModel: false });
    for (const job of ["compaction", "memory", "skill-review"] as const) expect(jobs.text(job, "claude")?.via, job).toBe("engine");
    await jobs.text("memory", "claude")!.generateText("p");
    await jobs.text("memory", "codex")!.generateText("p");
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    expect(openrouter.calls).toEqual([]);
  });

  it("does not open the skill review to an engine that cannot mount the bot's skill tools", () => {
    const { jobs, state } = setup();
    state.instances.set("pi", turnsOnly("pi", "piAgent", false));
    expect(jobs.text("skill-review", "pi")).toBeNull();
    // the other jobs do not depend on those tools
    expect(jobs.text("memory", "pi")?.via).toBe("helper");
    // and an engine with its own text call is held to the same gate, as before
    state.instances.set("claude", { ...state.instances.get("claude")!, adapter: { capabilities: { agentsMcp: false } } });
    expect(jobs.text("skill-review", "claude")).toBeNull();
  });
});

// server/memory-upkeep.test.ts drives upkeep with a scripted engine; here the
// engine is whatever the resolver hands it, as server/index.ts wires it.
describe("memory upkeep through the resolver", () => {
  const BOT: UpkeepBot = { id: "pi", name: "Bot pi" };
  const facts = JSON.stringify([{ text: "The person is vegetarian", kind: "preference", confidence: 0.9 }]);
  const turns = [{ person: "I'm vegetarian", bot: "Noted." }];

  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  const upkeep = (jobs: ReturnType<typeof setup>["jobs"]) => createMemoryUpkeep({
    bots: () => [BOT],
    bot: (id) => (id === BOT.id ? BOT : undefined),
    engine: (botId) => jobs.text("memory", botId),
    busy: () => false,
    addToAboutMe: () => 0,
    sourceLabel: () => 'chat "Plans"',
    quietMs: () => 60_000,
    tidyHour: () => 3,
    now: () => new Date(2026, 8, 25, 10, 0),
  });
  const memory = () => readFileSync(join(workspaceDir(BOT.id), "MEMORY.md"), "utf8");

  it("captures for a Pi bot once a helper is set", async () => {
    const { jobs, state } = setup();
    state.instances.set("claude", textEngine("claude", "claudeAgent", (prompt) => (prompt.includes("CAPTURE step") ? facts : '{"moves": []}')).instance);
    const service = upkeep(jobs);
    expect(service.status(BOT.id).modelSteps).toBe(true);
    expect(await service.capture({ botId: BOT.id, threadId: "t1", turns })).toMatchObject({ added: 1 });
    expect(memory()).toContain("The person is vegetarian");
    expect(state.booked.length).toBeGreaterThan(0);
    expect(state.booked.every((entry) => entry.row.botId === BOT.id && entry.row.instanceId === "claude" && entry.row.trigger.kind === "helper")).toBe(true);
  });

  it("captures nothing without a helper, and says the engine cannot, as today", async () => {
    const service = upkeep(setup({ helper: null }).jobs);
    expect(service.status(BOT.id).modelSteps).toBe(false);
    expect(await service.capture({ botId: BOT.id, threadId: "t1", turns })).toMatchObject({ added: 0, note: NO_TEXT_ENGINE });
    expect(await service.tidy(BOT.id)).toMatchObject({ contradictionsChecked: false, note: NO_TEXT_ENGINE });
  });

  it("captures nothing for a bot switched to never use the helper, with a helper set: the same answer as with none", async () => {
    const { jobs, state, claude } = setup();
    state.bots.set(BOT.id, { ...bot(BOT.id, "pi"), helperModel: false });
    const service = upkeep(jobs);
    expect(service.status(BOT.id).modelSteps).toBe(false);
    expect(await service.capture({ botId: BOT.id, threadId: "t1", turns })).toMatchObject({ added: 0, note: NO_TEXT_ENGINE });
    expect(await service.tidy(BOT.id)).toMatchObject({ contradictionsChecked: false, note: NO_TEXT_ENGINE });
    expect(claude.calls).toEqual([]);
  });

  it("writes nothing and fails nothing when the helper throws or the workspace is at its spend limit", async () => {
    const failing = setup();
    failing.state.instances.set("claude", textEngine("claude", "claudeAgent", () => Promise.reject(new Error("503 from the provider"))).instance);
    ensureWorkspace(BOT.id);
    const before = memory();
    expect(await upkeep(failing.jobs).capture({ botId: BOT.id, threadId: "t1", turns })).toMatchObject({ added: 0, note: "The capture call did not answer in time." });
    expect(memory()).toBe(before);

    const capped = setup();
    capped.state.overBudget = true;
    expect(await upkeep(capped.jobs).capture({ botId: BOT.id, threadId: "t1", turns })).toMatchObject({ added: 0, note: "The capture call did not answer in time." });
    expect(capped.claude.calls).toEqual([]);
    expect(memory()).toBe(before);
  });
});
