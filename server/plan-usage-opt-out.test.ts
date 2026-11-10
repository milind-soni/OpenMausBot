import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitResetClock } from "./limit-resets.ts";
import { clearPlanUsageCache, fetchPlanUsage, fileCredentialReader, loadPlanUsage, type PlanAccount, type PlanFetch } from "./plan-usage.ts";

const NOW = 1_800_000_000_000;
const account = (driver: PlanAccount["driver"] = "claude", environment: PlanAccount["environment"] = {}): PlanAccount => ({ id: driver, name: driver, driver, environment });
const credentials = () => ({ read: vi.fn(async (_account: PlanAccount) => ({ token: "fixture-token", accountId: "fixture-account", expired: false })) });
const usageFetch = () => vi.fn<PlanFetch>(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ five_hour: { utilization: 20 } }) }));

beforeEach(() => { clearPlanUsageCache(); });
afterEach(() => { clearPlanUsageCache(); vi.unstubAllEnvs(); });

describe("Claude plan usage opt-out", () => {
  it.each([
    [{ OMB_CLAUDE_PLAN_USAGE: "0" }, {}],
    [{ OMB_CLAUDE_PLAN_USAGE: "0" }, { OMB_CLAUDE_PLAN_USAGE: "1" }],
    [{}, { OMB_CLAUDE_PLAN_USAGE: "0" }],
  ])("does not read credentials or call usage when disabled globally or for the instance", async (env, environment) => {
    const reader = credentials();
    const fetch = usageFetch();
    const report = await fetchPlanUsage([account("claude", environment)], { credentials: reader, fetch, env, now: () => NOW });
    expect(reader.read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(report.providers).toEqual([expect.objectContaining({ driver: "claude", ok: false, error: expect.stringContaining("disabled"), fiveHour: expect.objectContaining({ available: false }), weekly: expect.objectContaining({ available: false }) })]);
    expect(JSON.stringify(report)).not.toContain("fixture-token");
  });

  it("honors the server environment when a caller does not supply one", async () => {
    vi.stubEnv("OMB_CLAUDE_PLAN_USAGE", "0");
    const reader = credentials();
    const fetch = usageFetch();
    await loadPlanUsage({ accounts: [account()], credentials: reader, fetch, now: NOW });
    expect(reader.read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("also blocks direct file/keychain reads before an instance can override the server opt-out", async () => {
    const readText = vi.fn(() => JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: NOW + 600_000 } }));
    const readClaudeKeychain = vi.fn(async () => "fixture-keychain");
    const reader = fileCredentialReader({ env: { OMB_CLAUDE_PLAN_USAGE: "0" }, now: () => NOW, readText, readClaudeKeychain });
    expect((await reader.read(account("claude", { OMB_CLAUDE_PLAN_USAGE: "1" }))).token).toBeNull();
    expect(readText).not.toHaveBeenCalled();
    expect(readClaudeKeychain).not.toHaveBeenCalled();
  });

  it("invalidates an enabled cached meter immediately when disabled and refetches on re-enable", async () => {
    const reader = credentials();
    const fetch = usageFetch();
    const input = { accounts: [account()], credentials: reader, fetch, now: NOW };
    expect((await loadPlanUsage({ ...input, env: {} })).providers[0]!.fiveHour.available).toBe(true);
    const disabled = await loadPlanUsage({ ...input, now: NOW + 1, env: { OMB_CLAUDE_PLAN_USAGE: "0" } });
    expect(disabled.providers[0]!.fiveHour.available).toBe(false);
    expect(disabled.providers[0]!.error).toContain("disabled");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect((await loadPlanUsage({ ...input, now: NOW + 2, env: {} })).providers[0]!.fiveHour.available).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("continues reading the other providers while disabling every Claude instance", async () => {
    const reader = credentials();
    const fetch = usageFetch();
    const accounts = [account(), { ...account(), id: "work-claude" }, account("codex"), account("grok"), account("opencode")];
    await fetchPlanUsage(accounts, { credentials: reader, fetch, env: { OMB_CLAUDE_PLAN_USAGE: "0" }, now: () => NOW });
    expect(reader.read.mock.calls.map(([entry]) => entry.driver).sort()).toEqual(["codex", "grok", "opencode"]);
    expect(fetch.mock.calls.every(([url]) => !url.includes("anthropic.com"))).toBe(true);
  });

  it("keeps CLI refusal holds when the limit-reset clock refreshes disabled usage", async () => {
    const reader = credentials();
    const fetch = usageFetch();
    const clock = new LimitResetClock({ accounts: () => [account()], now: () => NOW,
      loadUsage: (accounts) => loadPlanUsage({ accounts, credentials: reader, fetch, env: { OMB_CLAUDE_PLAN_USAGE: "0" }, now: NOW }),
    });
    try {
      clock.noteLimit("claude", NOW + 60_000);
      await clock.ensureFresh(0);
      expect(clock.resetAt("claude")).toBe(NOW + 60_000);
      expect(reader.read).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { clock.stop(); }
  });
});
