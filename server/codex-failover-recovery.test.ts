import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLimitTakeover } from "./host/limit-takeover.ts";
import { LimitFailovers, type LimitFailover } from "./limit-failover.ts";
import { LimitResetClock } from "./limit-resets.ts";
import type { PlanAccount, PlanProviderRow } from "./plan-usage.ts";

vi.mock("./workspace.ts", () => ({ supportsWorkspaceFiles: () => false }));

vi.mock("./plan-usage.ts", () => ({
  claudeHasExtraUsageRoom: () => false,
  loadPlanUsage: () => { throw new Error("Use the isolated usage fixture"); },
}));

const AT = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 60 * 60_000;
const RESET = AT + 4 * HOUR;
const codex = { instanceId: "codex-1", model: "gpt-test" };
const backup = { instanceId: "backup", model: "claude-test" };
const account = (id: string, driver: PlanAccount["driver"] = "codex"): PlanAccount => ({ id, driver, name: id, environment: {} });
const healthy = (id: string, resetsAt = RESET + HOUR, driver: PlanAccount["driver"] = "codex"): PlanProviderRow => ({
  id, name: id, driver, plan: null, ok: true, error: null,
  fiveHour: { available: true, remainingPercent: 90, usedPercent: 10, resetsAt: new Date(resetsAt).toISOString() },
  weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
  extra: [], models: [],
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(accounts = [account(codex.instanceId)]) {
  const dir = mkdtempSync(join(tmpdir(), "omb-codex-failover-recovery-"));
  let now = AT;
  let next = healthy(codex.instanceId);
  const state = { signedOut: false, modelHeld: false, allowed: true };
  const switchBack = vi.fn(() => state.allowed);
  const note = vi.fn();
  const clock = new LimitResetClock({ accounts: () => accounts, now: () => now,
    onCodexRecovery: (engine, reset) => failovers.usageRecovered(engine, reset),
    loadUsage: async () => ({ fetchedAt: new Date(now).toISOString(), providers: [next] }) });
  const deps = {
    file: join(dir, "failovers.json"), now: () => now,
    blockedUntil: (engine: string, model?: string) => clock.blockedUntil(engine, model),
    signedOut: () => state.signedOut, modelHeld: () => state.modelHeld, threadModel: () => backup,
    switchBack, note, engineName: (engine: string) => engine,
  };
  const failovers = new LimitFailovers(deps);
  const takeover = createLimitTakeover({
    file: join(dir, "notices.json"), now: () => now, configs: () => ({}), engines: () => [], context: {},
    blockedUntil: deps.blockedUntil, meterOnly: (engine, model) => clock.meterOnly(engine, model),
    record: (row) => failovers.record(row), chosen: () => [], engineName: deps.engineName, tell: () => {},
  });
  cleanups.push(() => { clock.stop(); rmSync(dir, { recursive: true, force: true }); });
  const record = (threadId: string, overrides: Partial<LimitFailover> = {}) => failovers.record({
    botId: "bot", threadId, from: codex, to: backup, resetsAt: RESET, at: AT, engineRefusal: "waiting", ...overrides,
  });
  return { clock, failovers, deps, state, record, takeover, switchBack, note, advance: (to: number) => { now = to; }, usage: (row: PlanProviderRow) => { next = row; } };
}

it("makes only the matching saved engine refusal eligible early, without doing work during refresh", async () => {
  const f = fixture([account(codex.instanceId), account("codex-2")]);
  f.clock.noteRefusal(codex.instanceId, RESET);
  f.takeover.moved("bot", "eligible", codex, backup, RESET, "engine");
  f.record("other-window", { resetsAt: RESET + HOUR });
  f.record("other-account", { from: { ...codex, instanceId: "codex-2" } });
  f.record("legacy", { engineRefusal: undefined });
  f.takeover.moved("bot", "model", codex, backup, RESET, "model");
  f.takeover.moved("bot", "credits", codex, backup, RESET, "credits");
  f.record("unnamed", { resetsAt: null });
  f.takeover.moved("bot", "signed-out", codex, backup, RESET, "signed-out");
  f.record("meter", { meter: true });
  f.record("chained", { to: { ...backup, instanceId: "second-backup" } });
  f.record("chained", { from: { ...backup, instanceId: "second-backup" } });
  f.advance(AT + 60_000);
  expect(f.failovers.restore("bot", "eligible")).toBe(false);
  await f.clock.refresh(true);
  expect(f.switchBack).not.toHaveBeenCalled();
  expect(f.note).not.toHaveBeenCalled();
  const restarted = new LimitFailovers(f.deps);
  expect(restarted.list().filter((row) => row.engineRefusal === "recovered").map((row) => row.threadId)).toEqual(["eligible"]);
  expect(restarted.restore("bot", "eligible")).toBe(true);
  expect(restarted.restore("bot", "eligible")).toBe(false);
  expect(f.switchBack).toHaveBeenCalledTimes(1);
  expect(f.note).toHaveBeenCalledTimes(1);
});

it("keeps the existing engine, model, sign-in and switch checks on the next turn", async () => {
  const f = fixture();
  f.clock.noteRefusal(codex.instanceId, RESET);
  f.record("t");
  f.advance(AT + 60_000);
  await f.clock.refresh(true);
  f.state.modelHeld = true;
  expect(f.failovers.restore("bot", "t")).toBe(false);
  f.state.modelHeld = false;
  f.state.signedOut = true;
  expect(f.failovers.restore("bot", "t")).toBe(false);
  f.state.signedOut = false;
  f.clock.noteRefusal(codex.instanceId, RESET);
  expect(f.failovers.restore("bot", "t")).toBe(false);
  await f.clock.refresh(true);
  expect(f.switchBack).not.toHaveBeenCalled();
  f.state.allowed = false;
  expect(f.failovers.restore("bot", "t")).toBe(false);
  f.state.allowed = true;
  expect(f.failovers.restore("bot", "t")).toBe(true);
});

it("does not accelerate from stale, failed, full or unchanged-window usage, or a manual release", async () => {
  const f = fixture();
  f.clock.noteRefusal(codex.instanceId, RESET);
  f.record("t");
  f.advance(AT + 60_000);
  f.clock.noteUsage({ fetchedAt: new Date(AT - 1).toISOString(), providers: [healthy(codex.instanceId)] });
  expect(f.failovers.list()[0]?.engineRefusal).toBe("waiting");
  const full = healthy(codex.instanceId);
  for (const row of [
    { ...full, ok: false, error: "Not available" },
    { ...full, fiveHour: { ...full.fiveHour, usedPercent: 100, remainingPercent: 0 } },
    healthy(codex.instanceId, RESET),
  ]) {
    f.usage(row);
    await f.clock.refresh(true);
    expect(f.failovers.restore("bot", "t")).toBe(false);
  }
  f.clock.release(codex.instanceId);
  expect(f.failovers.list()[0]?.engineRefusal).toBe("waiting");
  expect(f.failovers.restore("bot", "t")).toBe(false);
});

it("does not shorten a non-Codex wait when its own account hold clears", async () => {
  const f = fixture([account("claude", "claude")]);
  f.clock.noteRefusal("claude", RESET);
  f.record("t", { from: { instanceId: "claude", model: "claude-test" } });
  f.advance(AT + 60_000);
  f.usage(healthy("claude", RESET + HOUR, "claude"));
  await f.clock.refresh(true);
  expect(f.clock.blockedUntil("claude")).toBeNull();
  expect(f.failovers.restore("bot", "t")).toBe(false);
});
