import { chosenBackups } from "../automatic-recovery.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { LimitFailovers } from "../limit-failover.ts";
import { LimitResetClock, UNNAMED_LIMIT_MS } from "../limit-resets.ts";
import { parseCodexUsage, parseOpenCodeUsage } from "../plan-usage.ts";
import { MODEL_HOLD_MS, SIGNED_OUT_RECHECK_MS, SIGNED_OUT_REPEAT_MS, createLimitTakeover, signedOutStop, type LimitTakeoverDeps, type TakeoverEngine } from "./limit-takeover.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const TOOLS = { agentsMcp: true, customMcp: true, composioMcp: true } as unknown as TakeoverEngine["capabilities"];

function engine(instanceId: string, driverKind: string, models: string[], extra: Partial<TakeoverEngine> = {}): TakeoverEngine {
  return {
    instanceId, driverKind,
    snapshot: { state: "available", authenticated: true },
    models: { default: models[0]!, options: models.map((id) => ({ id, label: id })) },
    capabilities: TOOLS,
    ...extra,
  };
}

const CLAUDE = engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5"]);
const CODEX = engine("codex", "codex", ["gpt-6", "gpt-6-mini"]);
const GO = engine("opencode", "opencode", ["go-default"]);
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode Go" };
const on = (instanceId: string, model: string): ModelSelection => ({ instanceId, model });
const KAI = { id: "kai", name: "Kai" };

const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-limit-takeover-"));
  dirs.push(dir);
  return dir;
};

/** `dir`: the data folder, the same one again for a restart. */
function takeover(overrides: Partial<LimitTakeoverDeps> = {}, dir = freshDir()) {
  const now = { at: NOW };
  const told: Array<{ bot: string; text: string }> = [];
  const record = vi.fn();
  const instance = createLimitTakeover({
    file: join(dir, "limit-notices.json"),
    holdsFile: join(dir, "limit-takeover-holds.json"),
    engines: () => [CLAUDE, CODEX, GO],
    configs: () => ({}),
    context: {},
    blockedUntil: () => null,
    chosen: () => [],
    engineName: (id) => NAMES[id] ?? id,
    tell: (bot, text) => { told.push({ bot: bot.name, text }); },
    record,
    now: () => now.at,
    ...overrides,
  });
  return { instance, told, record, now };
}

const REASONING = { ...TOOLS, effortLevels: ["low", "medium", "high"], modelVariants: true } as TakeoverEngine["capabilities"];
const REASONING_ENGINES = () => [CLAUDE, CODEX, GO].map((one) => ({ ...one, capabilities: REASONING }));

describe("which AI carries on while one is limited", () => {
  it("keeps the chosen reasoning when the first backup is also the same account's default model", () => {
    const sameAccount = { ...on("codex", "gpt-6"), effort: "medium" } as const;
    const other = { ...on("opencode", "go-default"), variant: "thinking" };
    const { instance } = takeover({ engines: REASONING_ENGINES, chosen: () => [other, sameAccount] });
    expect(instance.backups("kai", on("codex", "gpt-6-mini"), "model")).toEqual([sameAccount, other]);
  });

  it("preserves configured reasoning effort and model variant on chosen backups", () => {
    const effortBackup: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", effort: "medium" };
    const variantBackup: ModelSelection = { instanceId: "opencode", model: "go-default", variant: "high" };
    const { instance } = takeover({ engines: REASONING_ENGINES, chosen: () => [effortBackup, variantBackup] });
    expect(instance.weighBackups("kai", on("codex", "gpt-6")).backups).toEqual([effortBackup, variantBackup]);
    expect(instance.backups("kai", on("codex", "gpt-6"))).toEqual([effortBackup, variantBackup]);

    const clock = new LimitResetClock({ accounts: () => [{ id: "codex", name: "Codex", driver: "codex", environment: {} }], now: () => NOW });
    clock.noteLimit("codex", NOW + HOUR);
    const room = takeover({ engines: REASONING_ENGINES, blockedUntil: (id) => clock.blockedUntil(id), resetAt: (id) => clock.resetAt(id) }).instance;
    expect(room.takeoverAtStart(KAI, on("codex", "gpt-6"), [effortBackup])).toEqual({ to: effortBackup, scope: "engine", resetsAt: NOW + HOUR });
  });

  it("leaves a backup's reasoning the AI no longer offers to its default, so the switch is not refused", () => {
    // gpt-6-mini now offers only "low", and this Codex has no named variants.
    const reasoningCodex: TakeoverEngine = { ...CODEX, capabilities: { ...TOOLS, effortLevels: ["low", "medium", "high"] } as TakeoverEngine["capabilities"],
      models: { ...CODEX.models, options: [CODEX.models.options[0]!, { id: "gpt-6-mini", label: "gpt-6-mini", effortLevels: ["low"] }] } };
    const { instance } = takeover({
      engines: () => [CLAUDE, reasoningCodex, GO],
      chosen: () => [{ ...on("codex", "gpt-6-mini"), effort: "high" }, { ...on("codex", "gpt-6"), effort: "medium" }, { ...on("opencode", "go-default"), variant: "high" }],
    });
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"))).toEqual([
      on("codex", "gpt-6-mini"), { ...on("codex", "gpt-6"), effort: "medium" }, on("opencode", "go-default"),
    ]);
  });

  it("keeps a bot on OpenCode Zen's free models while only the Go subscription's meter is full", () => {
    const openCode = engine("opencode", "opencode", ["opencode-go/kimi-k2", "opencode/big-pickle"]);
    const clock = new LimitResetClock({ accounts: () => [{ id: "opencode", name: "OpenCode", driver: "opencode", environment: {} }], now: () => NOW });
    clock.noteUsage({ fetchedAt: new Date(NOW).toISOString(), providers: [{ id: "opencode", name: "OpenCode", driver: "opencode", ok: true, error: null,
      ...parseOpenCodeUsage({ usage: { rolling: { percent: 100, resetsAt: new Date(NOW + HOUR).toISOString() }, weekly: { percent: 50, resetsAt: new Date(NOW + 48 * HOUR).toISOString() } } }) }] });
    const { instance } = takeover({ engines: () => [openCode, CLAUDE, CODEX], blockedUntil: (id, model) => clock.blockedUntil(id, model), resetAt: (id, model) => clock.resetAt(id, model),
      holdScope: (id, model) => clock.holdScope(id, model), chosen: () => [on("claude", "claude-opus-5-5")] });
    expect(instance.heldAtStart(KAI, on("opencode", "opencode/big-pickle")), "a free model has its own allowance").toBeNull();
    // The Go subscription's meter holds the Go models only: model scope, so the instance's other providers still serve.
    expect(instance.heldAtStart(KAI, on("opencode", "opencode-go/kimi-k2"))).toEqual({ scope: "model", resetsAt: NOW + HOUR });
    const chosen = takeover({ engines: () => [openCode, CLAUDE, CODEX], blockedUntil: (id, model) => clock.blockedUntil(id, model), chosen: () => [on("opencode", "opencode/big-pickle")] }).instance;
    expect(chosen.backups("kai", on("claude", "claude-opus-5-5"))[0], "a free model the person chose still carries on for another AI").toEqual(on("opencode", "opencode/big-pickle"));
    clock.noteRefusal("opencode", NOW + HOUR / 2);
    const free = instance.heldAtStart(KAI, on("opencode", "opencode/big-pickle"));
    expect(free?.resetsAt, "a refused free model waits for the refusal's reset, not the Go meter's later one").toBe(clock.blockedUntil("opencode", "opencode/big-pickle"));
    expect(free?.resetsAt).toBeLessThan(NOW + HOUR);
    expect(instance.heldAtStart(KAI, on("opencode", "opencode-go/kimi-k2"))?.scope, "an engine-wide refusal still holds the account").toBe("engine");
  });

  it("carries a full Go meter over to a Zen model of the same OpenCode instance", () => {
    const openCode = engine("opencode", "opencode", ["opencode-go/kimi-k2", "opencode/big-pickle"]);
    const clock = new LimitResetClock({ accounts: () => [{ id: "opencode", name: "OpenCode", driver: "opencode", environment: {} }], now: () => NOW });
    clock.noteUsage({ fetchedAt: new Date(NOW).toISOString(), providers: [{ id: "opencode", name: "OpenCode", driver: "opencode", ok: true, error: null,
      ...parseOpenCodeUsage({ usage: { rolling: { percent: 100, resetsAt: new Date(NOW + HOUR).toISOString() }, weekly: { percent: 50, resetsAt: new Date(NOW + 48 * HOUR).toISOString() } } }) }] });
    const taken = takeover({ engines: () => [openCode, CLAUDE, CODEX], blockedUntil: (id, model) => clock.blockedUntil(id, model), resetAt: (id, model) => clock.resetAt(id, model),
      holdScope: (id, model) => clock.holdScope(id, model), chosen: () => [] }).instance
      .takeoverAtStart(KAI, on("opencode", "opencode-go/kimi-k2"), [on("opencode", "opencode/big-pickle")]);
    expect(taken).toEqual({ to: on("opencode", "opencode/big-pickle"), scope: "model", resetsAt: NOW + HOUR });
  });

  it("carries on only with a backup the person chose, one that bills each use included", () => {
    const apiClaude = engine("claude-api", "claudeAgent", ["claude-opus-5-5"], { access: "api" });
    const keyedClaude = engine("claude-key", "claudeAgent", ["claude-opus-5-5"]);
    const keyed = { "claude-key": { environment: { ANTHROPIC_API_KEY: "sk-ant-fixture" } } } as unknown as InstanceConfigMap;
    expect(takeover({ engines: () => [CODEX, apiClaude] }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(takeover({ engines: () => [CODEX, keyedClaude], configs: () => keyed }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(takeover({ engines: () => [CODEX, apiClaude, GO] }).instance.backups("kai", on("codex", "gpt-6")), "nor one on a plan").toEqual([]);
    expect(takeover({ engines: () => [CODEX, apiClaude], chosen: () => [on("claude-api", "claude-opus-5-5")] }).instance.backups("kai", on("codex", "gpt-6")))
      .toEqual([on("claude-api", "claude-opus-5-5")]);
  });

  it("takes the backups the person chose, in their order, and never the limited AI", () => {
    const { instance } = takeover({ chosen: () => [on("opencode", "go-default"), on("codex", "gpt-6-mini"), on("claude", "claude-opus-5-5")] });
    expect(instance.backups("kai", on("codex", "gpt-6"))).toEqual([on("opencode", "go-default"), on("claude", "claude-opus-5-5")]);
  });

  it("picks no other AI by itself: with no backup chosen the bot waits for the reset", () => {
    const { instance, told } = takeover({ blockedUntil: (id) => (id === "codex" ? NOW + HOUR : null) });
    expect(instance.backups("kai", on("codex", "gpt-6")), "Claude and OpenCode Go are set up, but not chosen").toEqual([]);
    expect(instance.heldAtStart(KAI, on("codex", "gpt-6")), "the AI is tried as usual and the limit tells the person").toBeNull();
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt: NOW + HOUR });
    expect(told[0]!.text).toMatch(/^Codex reached its limit until .+, so Kai waits until then: no backup you chose can take over\.$/);
  });

  it("for one model's own limit tries that AI's default model first, and never the limited model", () => {
    const { instance } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    expect(instance.backups("kai", on("claude", "claude-sonnet-5"), "model")).toEqual([on("claude", "claude-opus-5-5"), on("codex", "gpt-6")]);
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "credits")).toEqual([on("codex", "gpt-6")]);
    expect(takeover().instance.backups("kai", on("claude", "claude-sonnet-5"), "model"), "no backup chosen: no other model is picked").toEqual([]);
    expect(takeover().instance.backups("kai", on("claude", "claude-sonnet-5"), "credits"), "no backup chosen: none for credits either").toEqual([]);
  });

  it("counts the installation's saved backup only while Automatic recovery is on", () => {
    const backup = on("codex", "gpt-6");
    const off = takeover({ chosen: () => chosenBackups(undefined, { enabled: false, backup }) }).instance;
    for (const scope of ["model", "credits", "engine"] as const) {
      expect(off.backups("kai", on("claude", "claude-sonnet-5"), scope), `recovery off, backup saved: none for ${scope}`).toEqual([]);
    }
    expect(chosenBackups({ fallback: [] }, { enabled: true, backup })).toEqual([backup]);
    expect(chosenBackups({ fallback: [on("claude", "claude-opus-5-5")] }, { enabled: false, backup }), "the bot's own list always counts").toEqual([on("claude", "claude-opus-5-5")]);
  });

  it("leaves out an AI that is signed out, held by its own limit, short of this AI's tools, or another sign-in to the same plan", () => {
    const signedOut = engine("claude", "claudeAgent", ["claude-opus-5-5"], { snapshot: { state: "available", authenticated: false } });
    const claudeChosen = { chosen: () => [on("claude", "claude-opus-5-5"), on("opencode", "go-default")] };
    expect(takeover({ engines: () => [signedOut, CODEX], ...claudeChosen }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(takeover({ blockedUntil: (id) => (id === "claude" ? NOW + HOUR : null), ...claudeChosen }).instance.backups("kai", on("codex", "gpt-6")))
      .toEqual([on("opencode", "go-default")]);
    const fewerTools = engine("claude", "claudeAgent", ["claude-opus-5-5"], { capabilities: { agentsMcp: true } as unknown as TakeoverEngine["capabilities"] });
    expect(takeover({ engines: () => [fewerTools, CODEX], ...claudeChosen }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    const secondCodex = engine("codex-2", "codex", ["gpt-6"]);
    expect(takeover({ engines: () => [CODEX, secondCodex], chosen: () => [on("codex-2", "gpt-6")] }).instance.backups("kai", on("codex", "gpt-6")),
      "never another sign-in to the same plan").toEqual([]);
    const keyed = { "codex-2": { environment: { OPENAI_API_KEY: "sk-test" } } } as unknown as InstanceConfigMap;
    expect(takeover({ engines: () => [CODEX, secondCodex], configs: () => keyed, chosen: () => [on("codex-2", "gpt-6")] }).instance.backups("kai", on("codex", "gpt-6")),
      "a pay-per-use key on the same AI is fine as a backup the person chose").toEqual([on("codex-2", "gpt-6")]);
  });

  it("has none for an AI it doesn't know", () => {
    expect(takeover().instance.backups("kai", on("gone", "m"))).toEqual([]);
  });

  it("says why it left out each backup the person chose, and leaves the choice as it was", () => {
    const unread = engine("cursor", "cursorAgent", ["auto"], { snapshot: { state: "unavailable", reason: "not read yet" } });
    const fewerTools = engine("claude", "claudeAgent", ["claude-opus-5-5"], { capabilities: { agentsMcp: true } as unknown as TakeoverEngine["capabilities"] });
    const secondCodex = engine("codex-2", "codex", ["gpt-6"]);
    const chosen = [on("codex", "gpt-6-mini"), on("gone", "m"), on("cursor", "auto"), on("codex-2", "gpt-6"), on("claude", "claude-opus-5-5"),
      on("opencode", "go-gone"), on("opencode", "go-default"), on("cursor", "auto")];
    const { instance } = takeover({ engines: () => [CODEX, unread, secondCodex, fewerTools, GO], chosen: () => chosen });
    const weighed = instance.weighBackups("kai", on("codex", "gpt-6"));
    expect(weighed.backups).toEqual([on("opencode", "go-default")]);
    expect(weighed.backups).toEqual(instance.backups("kai", on("codex", "gpt-6")));
    expect(weighed.skipped, "each once, in the person's order").toEqual([
      { selection: on("codex", "gpt-6-mini"), why: "limited" },
      { selection: on("gone", "m"), why: "not-configured" },
      { selection: on("cursor", "auto"), why: "not-ready", detail: "not read yet" },
      { selection: on("codex-2", "gpt-6"), why: "same-plan" },
      { selection: on("claude", "claude-opus-5-5"), why: "missing-capability", detail: "The backup does not support all of this AI's tools and attachments." },
      { selection: on("opencode", "go-gone"), why: "unknown-model" },
    ]);
  });

  it("names what keeps a backup from running: the refusal before a sign-in, which a custom endpoint never needs", () => {
    const custom = engine("cursor", "cursorAgent", ["auto"], { access: "custom", snapshot: { state: "available", authenticated: false } });
    const signedOutCodex = engine("codex-2", "codex", ["gpt-6"], { snapshot: { state: "available", authenticated: false } });
    const signedOutBlocked = engine("codex-3", "codex", ["gpt-6"], { snapshot: { state: "available", authenticated: false } });
    const blocked = new Set(["cursor", "codex-3"]);
    const { instance } = takeover({ engines: () => [CLAUDE, custom, signedOutCodex, signedOutBlocked], context: { refusal: (one) => blocked.has(one.instanceId) ? "Your organisation blocks this endpoint." : undefined },
      chosen: () => [on("cursor", "auto"), on("codex-2", "gpt-6"), on("codex-3", "gpt-6")] });
    expect(instance.weighBackups("kai", on("claude", "claude-opus-5-5")).skipped).toEqual([
      { selection: on("cursor", "auto"), why: "not-ready", detail: "Your organisation blocks this endpoint." },
      { selection: on("codex-2", "gpt-6"), why: "not-ready", detail: "signed out" },
      { selection: on("codex-3", "gpt-6"), why: "not-ready", detail: "Your organisation blocks this endpoint." },
    ]);
  });

  it("says a backup is at its own limit, holding that model, signed out, or one the thread's approval level must ask about", () => {
    const chosen = { chosen: () => [on("claude", "claude-opus-5-5"), on("opencode", "go-default")] };
    const limited = takeover({ blockedUntil: (id) => (id === "claude" ? NOW + HOUR : null), ...chosen }).instance;
    expect(limited.weighBackups("kai", on("codex", "gpt-6")).skipped).toEqual([{ selection: on("claude", "claude-opus-5-5"), why: "limited" }]);
    const held = takeover(chosen).instance;
    held.holdModel(on("claude", "claude-opus-5-5"), "model");
    expect(held.weighBackups("kai", on("codex", "gpt-6")).skipped).toEqual([{ selection: on("claude", "claude-opus-5-5"), why: "model-held" }]);
    const signedOut = takeover(chosen).instance;
    signedOut.noteSignedOut("claude");
    expect(signedOut.weighBackups("kai", on("codex", "gpt-6")).skipped).toEqual([{ selection: on("claude", "claude-opus-5-5"), why: "signed-out" }]);
    expect(takeover(chosen).instance.weighBackups("kai", on("codex", "gpt-6"), "engine", "edits").skipped.map((one) => one.why)).toContain("needs-approval");
    expect(takeover({ chosen: () => [on("claude", "claude-opus-5-5")] }).instance.weighBackups("kai", on("claude", "claude-opus-5-5"), "model").skipped,
      "the refused model itself is no backup passed over").toEqual([]);
  });

  it("writes each backup it passed over to the server log", () => {
    const lines: string[] = [];
    const { instance } = takeover({ log: (line) => lines.push(line) });
    instance.passedOver(KAI, on("codex", "gpt-6"), "engine", [
      { selection: on("cursor", "auto"), why: "not-ready", detail: "not read yet" },
      { selection: on("claude", "claude-opus-5-5"), why: "probe-timed-out" },
    ]);
    instance.passedOver(KAI, on("codex", "gpt-6"), "engine", []);
    instance.passedOver(KAI, on("codex", "gpt-6"), "engine", [{ selection: on("ollama", "llama"), why: "not-ready", detail: "Can't reach Ollama at http://me:hunter2pass@10.0.0.5:11434" }]);
    expect(lines.pop(), "an address's credential stays out of the log").not.toContain("hunter2pass");
    expect(lines).toEqual([
      "limit takeover: Kai (kai) on codex/gpt-6 (engine) passed over backup cursor/auto: not-ready (not read yet)",
      "limit takeover: Kai (kai) on codex/gpt-6 (engine) passed over backup claude/claude-opus-5-5: probe-timed-out",
    ]);
  });
});

describe("a model's own limit", () => {
  const error = (limit: "model" | "credits" | "engine", limitResetsAt?: number) => ({
    eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId: "t1",
    type: "runtime.error", message: "limit", limit, ...(limitResetsAt ? { limitResetsAt } : {}),
  }) as RuntimeEvent;

  it("starts a no-backup bot's turn on its own model while that model is held, and a bot with a backup on the same AI's default", () => {
    const opus = on("claude", "claude-sonnet-5");
    const none = takeover();
    none.instance.noteRuntimeEvent("kai", opus, error("model", NOW + 2 * HOUR));
    expect(none.instance.heldAtStart(KAI, opus), "no backup chosen: the turn is tried as usual and the limit shows").toBeNull();
    const chosen = takeover({ chosen: () => [on("codex", "gpt-6")] });
    chosen.instance.noteRuntimeEvent("kai", opus, error("model", NOW + 2 * HOUR));
    expect(chosen.instance.heldAtStart(KAI, opus), "a backup chosen: it carries on as before").toMatchObject({ scope: "model" });
  });

  it("holds that model alone until the reset it named, at most six hours, an hour when it named none, and not once it works", () => {
    const { instance, now } = takeover({ chosen: () => [on("claude", "claude-opus-5-5"), on("opencode", "go-default")] });
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), error("model", NOW + 2 * HOUR));
    expect(instance.modelHeld(on("claude", "claude-opus-5-5"))).toEqual({ until: NOW + 2 * HOUR, resetsAt: NOW + 2 * HOUR, scope: "model" });
    expect(instance.modelHeld(on("claude", "claude-sonnet-5")), "the AI's other models still work").toBeNull();
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), error("model", NOW + 50 * HOUR));
    expect(instance.modelHeld(on("claude", "claude-opus-5-5")), "tried again after six hours, the named reset kept")
      .toEqual({ until: NOW + MODEL_HOLD_MS, resetsAt: NOW + 50 * HOUR, scope: "model" });
    instance.holdModel(on("claude", "claude-sonnet-5"), "credits");
    expect(instance.modelHeld(on("claude", "claude-sonnet-5"))).toEqual({ until: NOW + UNNAMED_LIMIT_MS, scope: "credits" });
    instance.noteRuntimeEvent("kai", on("codex", "gpt-6"), error("engine"));
    expect(instance.modelHeld(on("codex", "gpt-6")), "an engine's own limit is the reset clock's to hold").toBeNull();
    expect(instance.backups("kai", on("codex", "gpt-6")), "a held model carries on nothing").toEqual([on("opencode", "go-default")]);

    instance.worked("kai", on("claude", "claude-opus-5-5"));
    expect(instance.modelHeld(on("claude", "claude-opus-5-5"))).toBeNull();
    now.at = NOW + UNNAMED_LIMIT_MS + 1;
    expect(instance.modelHeld(on("claude", "claude-sonnet-5"))).toBeNull();
  });

  it("holds every model one shared allowance covers", () => {
    const { instance } = takeover();
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"),
      { ...error("model", NOW + 2 * HOUR), limitModels: ["claude-opus-5-5", "claude-sonnet-5"] } as RuntimeEvent);
    expect(instance.modelHeld(on("claude", "claude-opus-5-5"))).toEqual({ until: NOW + 2 * HOUR, resetsAt: NOW + 2 * HOUR, scope: "model" });
    expect(instance.modelHeld(on("claude", "claude-sonnet-5")), "the same allowance holds it too")
      .toEqual({ until: NOW + 2 * HOUR, resetsAt: NOW + 2 * HOUR, scope: "model" });
    expect(instance.modelHeld(on("codex", "gpt-6")), "another AI is untouched").toBeNull();
  });
});

describe("what the person hears", () => {
  it("says once per bot for each stretch of a limit what carries on, and again once a turn on that AI worked", () => {
    const { instance, told } = takeover();
    const resetsAt = NOW + 4 * HOUR;
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt, scope: "engine", backup: on("claude", "claude-opus-5-5") });
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt, scope: "engine", backup: on("claude", "claude-opus-5-5") });
    instance.tell({ id: "rosa", name: "Rosa" }, on("codex", "gpt-6"), { resetsAt });
    expect(told.map((entry) => entry.bot)).toEqual(["Kai", "Rosa"]);
    expect(told[0]!.text).toMatch(/^Codex reached its limit until .+, so Kai is using Claude meanwhile\.$/);
    expect(told[1]!.text).toMatch(/^Codex reached its limit until .+, so Rosa waits until then: no backup you chose can take over\.$/);
    instance.worked("kai", on("codex", "gpt-6"));
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt, backup: on("claude", "claude-opus-5-5") });
    expect(told).toHaveLength(3);
  });

  it("names the model for a model's own limit, and the same AI's other model when that carries on", () => {
    const { instance, told } = takeover();
    instance.tell(KAI, on("claude", "claude-sonnet-5"), { scope: "credits", backup: on("claude", "claude-opus-5-5") });
    instance.tell(KAI, on("claude", "claude-opus-5-5"), { scope: "model", backup: on("codex", "gpt-6") });
    expect(told.map((entry) => entry.text)).toEqual([
      "Claude claude-sonnet-5's extra usage credits are used up, so Kai is using Claude claude-opus-5-5 meanwhile.",
      "Claude claude-opus-5-5 reached its limit, so Kai is using Codex meanwhile.",
    ]);
  });

  it("files one incident per bot for each stretch of a limit, apart from the person's notice", () => {
    const { instance, told } = takeover();
    const resetsAt = NOW + 4 * HOUR;
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt });
    expect(instance.firstIncident("kai", on("codex", "gpt-6"), "engine", resetsAt), "the notice is not the incident").toBe(true);
    expect(instance.firstIncident("kai", on("codex", "gpt-6"), "engine", resetsAt)).toBe(false);
    expect(instance.firstIncident("rosa", on("codex", "gpt-6"), "engine", resetsAt)).toBe(true);
    expect(instance.firstIncident("kai", on("claude", "claude-opus-5-5"), "model"), "another limit is another stretch").toBe(true);
    instance.worked("kai", on("codex", "gpt-6"));
    expect(instance.firstIncident("kai", on("codex", "gpt-6"), "engine", resetsAt), "a new stretch once it worked").toBe(true);
    expect(told).toHaveLength(1);
  });

  it("records a conversation that moved, so it goes back once the limit resets", () => {
    const { instance, record } = takeover();
    instance.moved("kai", "t1", on("codex", "gpt-6"), on("claude", "claude-opus-5-5"), NOW + HOUR);
    instance.moved("kai", "t2", on("codex", "gpt-6"), on("claude", "claude-opus-5-5"));
    expect(record.mock.calls.map(([failover]) => failover)).toEqual([
      { botId: "kai", threadId: "t1", from: on("codex", "gpt-6"), to: on("claude", "claude-opus-5-5"), resetsAt: NOW + HOUR, at: NOW },
      { botId: "kai", threadId: "t2", from: on("codex", "gpt-6"), to: on("claude", "claude-opus-5-5"), resetsAt: null, at: NOW },
    ]);
  });
});

describe("a new conversation once an AI is known to be at its limit", () => {
  const event = (threadId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId, type, ...extra }) as RuntimeEvent;
  /** The reset clock and the takeover as the server wires them, on one data folder: `boot` again is a restart. */
  function server() {
    const dir = freshDir();
    const at = { now: NOW };
    const boot = () => {
      const clock = new LimitResetClock({ accounts: () => [], now: () => at.now, file: join(dir, "limit-holds.json") });
      const { instance, told } = takeover({ blockedUntil: (id) => clock.blockedUntil(id), resetAt: (id) => clock.resetAt(id), now: () => at.now, chosen: () => [on("codex", "gpt-6")] }, dir);
      return { clock, instance, told };
    };
    return { at, boot };
  }
  /** A turn on Claude that its usage limit refused. */
  const refused = (clock: LimitResetClock, threadId: string, limitResetsAt?: number) => {
    clock.noteRuntimeEvent("claude", event(threadId, "turn.started"));
    clock.noteRuntimeEvent(undefined, event(threadId, "runtime.error", { message: "limit", limit: "engine", ...(limitResetsAt ? { limitResetsAt } : {}) }));
    clock.noteRuntimeEvent(undefined, event(threadId, "turn.completed", { ok: false, stopReason: "quota" }));
  };
  const ROSA = { id: "rosa", name: "Rosa" };

  it("starts every bot's next conversation on the AI that carries on, a restart included, until the limit resets", () => {
    const { at, boot } = server();
    const first = boot();
    refused(first.clock, "t1", NOW + 5 * HOUR);
    expect(first.instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });
    expect(first.instance.heldAtStart(ROSA, on("claude", "claude-sonnet-5")), "every bot that uses it").toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });

    at.now = NOW + 20 * 60_000;
    const restarted = boot();
    expect(restarted.clock.blockedUntil("claude"), "a restart, or a sleep the Cloud was stopped for, still knows the limit").toBe(NOW + 5 * HOUR);
    expect(restarted.instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });
    expect(restarted.instance.backups("kai", on("claude", "claude-opus-5-5"))).toEqual([on("codex", "gpt-6")]);

    at.now = NOW + 5 * HOUR + 1;
    expect(restarted.instance.heldAtStart(KAI, on("claude", "claude-opus-5-5")), "back on its own AI once the limit resets").toBeNull();
  });

  it("with no reset named, or one already past, holds the AI until it is checked again an hour after its last refusal", () => {
    const { at, boot } = server();
    const { clock, instance } = boot();
    refused(clock, "t1", NOW - 60_000);
    expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine" });
    at.now = NOW + UNNAMED_LIMIT_MS - 1;
    expect(boot().instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine" });
    at.now = NOW + UNNAMED_LIMIT_MS + 1;
    expect(boot().instance.heldAtStart(KAI, on("claude", "claude-opus-5-5")), "the next turn checks it again").toBeNull();
  });

  it("names the backup a room member's turn starts on, says it once, and records nothing to go back to", () => {
    const { boot } = server();
    const { clock, instance, told } = boot();
    const own = [on("codex", "gpt-6")];
    expect(instance.takeoverAtStart(KAI, on("claude", "claude-opus-5-5"), own), "nothing holds Claude yet").toBeNull();
    refused(clock, "t1", NOW + 5 * HOUR);
    expect(instance.takeoverAtStart(KAI, on("claude", "claude-opus-5-5"), []), "only the backups given, never the installation's").toBeNull();
    const lines: string[] = [];
    const logged = takeover({ blockedUntil: (id) => clock.blockedUntil(id), log: (line) => lines.push(line) }).instance;
    expect(logged.takeoverAtStart(KAI, on("claude", "claude-opus-5-5"), [on("opencode", "go-gone")]), "none usable").toBeNull();
    expect(lines, "still says why each was left out").toEqual([expect.stringContaining("passed over backup opencode/go-gone: unknown-model")]);
    expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"), false, []), "nothing to carry on with").toBeNull();
    const taken = instance.takeoverAtStart(KAI, on("claude", "claude-opus-5-5"), own);
    expect(taken).toEqual({ to: on("codex", "gpt-6"), scope: "engine", resetsAt: NOW + 5 * HOUR });
    const rows = instance.carryOnRows(KAI, on("claude", "claude-opus-5-5"), taken!.to, taken!);
    expect(rows).toEqual([{ name: expect.stringMatching(/^recovery: Claude hit its limit \(resets .+\), so Codex took over\.$/), ok: true }]);
    instance.carryOnRows(KAI, on("claude", "claude-opus-5-5"), taken!.to, taken!);
    expect(told, "the person hears it once for the stretch").toHaveLength(1);
    expect(instance.takeoverAtStart({ ...KAI, approvalMode: "edits" }, on("claude", "claude-opus-5-5"), own), "a level that must ask first").toBeNull();
  });

  it("goes to no AI the thread's approval level can't move to by itself, and then tries its own AI as usual", () => {
    const { boot } = server();
    const { clock, instance } = boot();
    refused(clock, "t1", NOW + 5 * HOUR);
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "engine", "edits")).toEqual([]);
    expect(instance.heldAtStart({ ...KAI, approvalMode: "edits" }, on("claude", "claude-opus-5-5"))).toBeNull();
    expect(instance.heldAtStart({ ...KAI, approvalMode: "full" }, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });
  });

  it("is off with the quota switch, unless Automatic recovery has backups of its own for a limit", () => {
    const { boot } = server();
    const { clock } = boot();
    refused(clock, "t1", NOW + 5 * HOUR);
    const off = takeover({ blockedUntil: (id) => clock.blockedUntil(id), enabled: () => false }).instance;
    expect(off.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toBeNull();
    expect(off.heldAtStart(KAI, on("claude", "claude-opus-5-5"), true)).toEqual({ scope: "engine" });
    expect(off.takeoverAtStart(KAI, on("claude", "claude-opus-5-5"), [on("codex", "gpt-6")]), "a room member's own backup too").toBeNull();
  });

  it("keeps one model's own limit through a restart, and a turn that works on another model leaves it held", () => {
    const dir = freshDir();
    const codexChosen = { chosen: () => [on("codex", "gpt-6")] };
    const { instance } = takeover(codexChosen, dir);
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), event("t1", "runtime.error", { message: "limit", limit: "model", limitResetsAt: NOW + 2 * HOUR }));
    instance.noteRuntimeEvent("kai", on("claude", "claude-sonnet-5"), event("t2", "turn.completed", { ok: true }));
    const restarted = takeover(codexChosen, dir).instance;
    expect(restarted.modelHeld(on("claude", "claude-opus-5-5"))).toEqual({ until: NOW + 2 * HOUR, resetsAt: NOW + 2 * HOUR, scope: "model" });
    expect(restarted.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "model", resetsAt: NOW + 2 * HOUR });
  });

  it("says once per bot what carries on in a conversation that moved at its start, and records it to go back", () => {
    const { instance, told, record } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    expect(instance.carriedOn(KAI, "t1", on("claude", "claude-opus-5-5"), on("codex", "gpt-6"), { scope: "engine", resetsAt: NOW + HOUR }))
      .toEqual([{ name: expect.stringMatching(/^recovery: Claude hit its limit \(resets .+\), so Codex took over\.$/), ok: true }]);
    expect(instance.carriedOn(KAI, "t2", on("claude", "claude-opus-5-5"), on("codex", "gpt-6"), { scope: "engine", resetsAt: NOW + HOUR })).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(record.mock.calls.map(([failover]) => failover.threadId)).toEqual(["t1", "t2"]);
  });
});

describe("a sign-out that goes on", () => {
  const CLAUDE_ON = on("claude", "claude-opus-5-5");
  const ROSA = { id: "rosa", name: "Rosa" };

  it("says it again once a day across all bots, however often turns are refused in between, until it is signed in", () => {
    const { instance, told, now } = takeover({ where: "on the Cloud" });
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).not.toBeNull();
    for (let turn = 0; turn < 8; turn += 1) {
      now.at += 2 * HOUR;
      expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).toBeNull();
    }
    expect(told).toHaveLength(1);
    now.at += SIGNED_OUT_REPEAT_MS - 16 * HOUR + 1;
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" }), "a day after it was last said").not.toBeNull();
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).toBeNull();
    expect(instance.tell(ROSA, CLAUDE_ON, { scope: "signed-out" }), "another bot's first time is still its own").not.toBeNull();
    now.at += SIGNED_OUT_REPEAT_MS + 1;
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).not.toBeNull();
    expect(instance.tell(ROSA, CLAUDE_ON, { scope: "signed-out" }), "the day's one reminder went to Kai").toBeNull();
    instance.signedIn("claude");
    expect(told).toHaveLength(4);
  });

  it("speaks up when a bot had gone quiet under a long mark, and starts afresh after signing in", () => {
    const dir = freshDir();
    const before = takeover({}, dir);
    before.instance.noteSignedOut("claude");
    expect(before.instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).not.toBeNull();
    expect(before.instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).toBeNull();
    writeFileSync(join(dir, "limit-notices.json"), JSON.stringify({ [`kai\u0000signed-out\u0000claude`]: NOW + 29 * 24 * HOUR }));
    const after = takeover({}, dir);
    after.now.at = NOW + HOUR;
    expect(after.instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" }), "once after the update, then on the schedule").not.toBeNull();
    expect(after.instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).toBeNull();
    after.instance.noteSignedOut("claude");
    after.instance.signedIn("claude");
    after.instance.noteSignedOut("claude");
    expect(after.instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" }), "a new sign-out is told at once").not.toBeNull();
  });

  it("names the bots with nothing to carry on for them, and leaves out those with a backup", () => {
    const mira = { id: "mira", name: "Mira", modelSelection: CLAUDE_ON };
    const lin = { id: "lin", name: "Lin", modelSelection: CLAUDE_ON };
    const { instance } = takeover({ where: "on the Cloud", botsOn: () => [mira, lin] as never, signedOutChosen: (botId) => botId === "lin" ? [on("codex", "gpt-6")] : [] });
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" }))
      .toBe("Claude is signed out on the Cloud. Sign in again in Settings → AI to keep using it. Until then Mira can't run: it has no backup.");
  });
});

describe("an AI that is signed out", () => {
  const event = (type: string, extra: Record<string, unknown> = {}) =>
    ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId: "t1", type, ...extra }) as RuntimeEvent;
  const CLAUDE_ON = on("claude", "claude-opus-5-5");
  /** A turn on Claude that stopped because Claude is signed out, as Claude Code says it. */
  const signedOut = (instance: ReturnType<typeof takeover>["instance"], said = "Invalid API key · Please run /login") => {
    instance.noteRuntimeEvent("kai", CLAUDE_ON, event("runtime.error", { message: said, setup: true }));
    instance.noteRuntimeEvent("kai", CLAUDE_ON, event("turn.completed", { ok: false, stopReason: "auth_required" }));
  };

  it("sends new turns to a backup the person chose, says it once with the way to sign in, and goes back once signed in", () => {
    const { instance, told, record } = takeover({ chosen: () => [on("codex", "gpt-6")], where: "on the Cloud" });
    signedOut(instance);
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toEqual({ scope: "signed-out" });
    expect(instance.backups("kai", CLAUDE_ON, "signed-out")).toEqual([on("codex", "gpt-6")]);
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).toBe("Claude is signed out on the Cloud. Sign in again in Settings → AI to keep using it.");
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out", backup: on("codex", "gpt-6") }), "once, not once a turn").toBeNull();
    signedOut(instance);
    expect(instance.carriedOn(KAI, "t2", CLAUDE_ON, on("codex", "gpt-6"), { scope: "signed-out" }))
      .toEqual([{ name: "recovery: Claude is signed out, so Codex took over.", nameCode: "chat.notice.failoverSignedOut", nameParams: { from: "Claude", to: "Codex" }, ok: true }]);
    expect(told.map((entry) => entry.text)).toEqual(["Claude is signed out on the Cloud. Sign in again in Settings → AI to keep using it."]);
    expect(record.mock.calls.at(-1)![0]).toMatchObject({ threadId: "t2", why: "signed-out", resetsAt: null });

    instance.signedIn("claude");
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toBeNull();
    expect(instance.stillSignedOut("claude")).toBe(false);
    signedOut(instance);
    expect(instance.carriedOn(KAI, "t3", CLAUDE_ON, on("codex", "gpt-6"), { scope: "signed-out" }), "a new sign-out is told again").toEqual([
      { name: "recovery: Claude is signed out, so Codex took over.", nameCode: "chat.notice.failoverSignedOut", nameParams: { from: "Claude", to: "Codex" }, ok: true },
      { name: "notice: Claude is signed out on the Cloud, so Kai is using Codex meanwhile. Sign in again in Settings → AI to keep using Claude.", ok: true, setup: true },
    ]);
  });

  it("picks no AI by itself for it, so with no backup chosen the AI is tried as usual", () => {
    const { instance } = takeover();
    signedOut(instance);
    expect(instance.backups("kai", CLAUDE_ON, "signed-out")).toEqual([]);
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toBeNull();
  });

  it("lets another sign-in to the same AI stand in when the person chose it, never a signed-out one", () => {
    const work = engine("claude-work", "claudeAgent", ["claude-opus-5-5"]);
    const { instance } = takeover({ engines: () => [CLAUDE, work, CODEX], chosen: () => [on("claude-work", "claude-opus-5-5"), on("codex", "gpt-6")] });
    signedOut(instance);
    expect(instance.backups("kai", CLAUDE_ON, "signed-out")).toEqual([on("claude-work", "claude-opus-5-5"), on("codex", "gpt-6")]);
    expect(instance.backups("kai", on("codex", "gpt-6")), "and no limit's backup is an AI known to be signed out").not.toContainEqual(on("claude", "claude-opus-5-5"));
  });

  it("is tried again by a new turn an hour on, unless its status still says signed out; a turn that works ends it", () => {
    let status = false;
    const { instance, now } = takeover({ chosen: () => [on("codex", "gpt-6")], signedOutNow: () => status });
    signedOut(instance);
    now.at = NOW + SIGNED_OUT_RECHECK_MS + 1;
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toBeNull();
    expect(instance.stillSignedOut("claude"), "a conversation that moved still waits for it").toBe(true);
    status = true;
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toEqual({ scope: "signed-out" });
    instance.noteRuntimeEvent("rosa", CLAUDE_ON, event("turn.completed", { ok: true }));
    expect(instance.stillSignedOut("claude")).toBe(false);
  });

  it("remembers a sign-out through a restart", () => {
    const dir = freshDir();
    signedOut(takeover({}, dir).instance);
    expect(takeover({ chosen: () => [on("codex", "gpt-6")] }, dir).instance.heldAtStart(KAI, CLAUDE_ON)).toEqual({ scope: "signed-out" });
  });

  it("an account out of credit is no sign-out, even when its AI stops the turn as one", () => {
    const { instance } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    signedOut(instance, "Your Grok account is out of credits. Add credits with Grok, then run it again.");
    expect(instance.stillSignedOut("claude")).toBe(false);
    expect(signedOutStop("auth_required", "Grok is not signed in to your grok.com account")).toBe(true);
    expect(signedOutStop("auth_required", undefined)).toBe(true);
    expect(signedOutStop("auth_required", "Your xAI subscription is inactive")).toBe(false);
    expect(signedOutStop("quota", "Not logged in · Please run /login")).toBe(false);
  });

  it("files one incident a sign-out, and another once it was signed in again", () => {
    const { instance } = takeover();
    signedOut(instance);
    expect(instance.firstIncident("kai", CLAUDE_ON, "signed-out")).toBe(true);
    expect(instance.firstIncident("kai", CLAUDE_ON, "signed-out")).toBe(false);
    instance.signedIn("claude");
    expect(instance.firstIncident("kai", CLAUDE_ON, "signed-out")).toBe(true);
  });
});

it("sends a signed-out AI's turns only to the backups a turn its AI never started would get", () => {
  const event = (type: string, extra: Record<string, unknown> = {}) =>
    ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId: "t1", type, ...extra }) as RuntimeEvent;
  let startup: ModelSelection[] = [];
  const { instance } = takeover({ chosen: () => [on("opencode", "go-default")], signedOutChosen: () => startup });
  instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), event("turn.completed", { ok: false, stopReason: "auth_required" }));
  expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "signed-out"), "Automatic recovery off and no list of the bot's own").toEqual([]);
  expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toBeNull();
  expect(instance.backups("kai", on("codex", "gpt-6")), "a usage limit's backups stay its own").toEqual([on("opencode", "go-default")]);
  startup = [on("codex", "gpt-6")];
  expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "signed-out" });
});

describe("a conversation moved off Codex while its window was full", () => {
  const rolling = (credits?: unknown) => ({ fetchedAt: new Date(NOW).toISOString(), providers: [{ id: "codex", name: "Codex", driver: "codex", ok: true, error: null, ...parseCodexUsage({
    rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 7 * 86400, reset_at: Math.floor((NOW + 90 * HOUR) / 1000) } },
    ...(credits ? { credits } : {}),
  }) }] });

  function moved(refused = false) {
    const dir = freshDir();
    const now = { at: NOW };
    const clock = new LimitResetClock({ accounts: () => [{ id: "codex", name: "Codex", driver: "codex", environment: {} }], now: () => now.at });
    clock.noteUsage(rolling());
    if (refused) clock.noteLimit("codex", NOW + 2 * HOUR);
    let current = on("claude", "claude-sonnet-5");
    const failovers = new LimitFailovers({ file: join(dir, "limit-failovers.json"), now: () => now.at, blockedUntil: (id, model) => clock.blockedUntil(id, model),
      threadModel: () => current, switchBack: (row) => { current = row.from; return true; }, note: () => {}, engineName: (id) => NAMES[id] ?? id });
    const { instance } = takeover({ chosen: () => [on("claude", "claude-sonnet-5")], blockedUntil: (id, model) => clock.blockedUntil(id, model),
      resetAt: (id, model) => clock.resetAt(id, model), meterOnly: (id, model) => clock.meterOnly(id, model), record: (row) => failovers.record(row), now: () => now.at }, dir);
    const codexOn = on("codex", "gpt-6");
    const held = instance.heldAtStart(KAI, codexOn);
    expect(held).toMatchObject({ scope: "engine" });
    instance.carriedOn(KAI, "t1", codexOn, on("claude", "claude-sonnet-5"), held!);
    current = on("claude", "claude-sonnet-5");
    return { clock, failovers, instance, now, codexOn, held: held! };
  }

  it("goes back at its next turn once credits appear, though the window is still full", () => {
    const { clock, failovers } = moved();
    expect(failovers.restore("kai", "t1"), "the meter still holds Codex").toBe(false);
    clock.noteUsage(rolling({ has_credits: true, unlimited: false, balance: "12.50" }));
    expect(failovers.restore("kai", "t1")).toBe(true);
  });

  it("stays on the backup after a refusal from Codex itself, credits or not", () => {
    const { clock, failovers } = moved(true);
    clock.noteUsage(rolling({ has_credits: true, unlimited: false, balance: "12.50" }));
    expect(failovers.restore("kai", "t1")).toBe(false);
  });
});
