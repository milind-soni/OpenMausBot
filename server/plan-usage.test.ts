import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPlanUsageCache,
  fetchPlanUsage,
  fileCredentialReader,
  loadPlanUsage,
  parseClaudeUsage,
  parseCodexUsage,
  parseGrokUsage,
  planAccountsFromInstances,
  type PlanAccount,
  type PlanFetch,
  type PlanResponse,
} from "./plan-usage.ts";

const SECRET = "plan-usage-fixture-secret";
const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearPlanUsageCache();
});

function jsonResponse(body: unknown, status = 200): PlanResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function account(driver: PlanAccount["driver"], extras: Partial<PlanAccount> = {}): PlanAccount {
  return {
    id: driver,
    name: driver === "claude" ? "Claude" : driver === "codex" ? "Codex" : "Grok",
    driver,
    environment: {},
    ...extras,
  };
}

describe("plan usage parsers", () => {
  it("turns Claude utilization into remaining percent and keeps opus as a model window", () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
      five_hour_opus: { utilization: 10, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day_opus: { utilization: 15, resets_at: "2026-10-03T00:00:00.000Z" },
      seven_day_sonnet: { utilization: 8, resets_at: "2026-10-03T00:00:00.000Z" },
      access_token: SECRET,
      claudeAiOauth: { accessToken: SECRET },
    });
    expect(parsed.fiveHour).toMatchObject({ available: true, usedPercent: 25, remainingPercent: 75, resetsAt: "2026-09-26T12:00:00.000Z" });
    expect(parsed.weekly).toMatchObject({ available: true, usedPercent: 40, remainingPercent: 60 });
    expect(parsed.extra).toEqual([]);
    expect(parsed.models).toEqual([
      {
        name: "Opus",
        windows: [
          expect.objectContaining({ label: "5-hour", usedPercent: 10, remainingPercent: 90 }),
          expect.objectContaining({ label: "Weekly", usedPercent: 15, remainingPercent: 85, resetsAt: "2026-10-03T00:00:00.000Z" }),
        ],
      },
      {
        name: "Sonnet",
        windows: [
          expect.objectContaining({ label: "Weekly", usedPercent: 8, remainingPercent: 92 }),
        ],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("keeps seven_day_oauth_apps on an extra line instead of a model row", () => {
    const parsed = parseClaudeUsage({
      seven_day_oauth_apps: { utilization: 12, resets_at: "2026-10-03T00:00:00.000Z" },
    });
    expect(parsed.extra).toEqual([
      expect.objectContaining({ label: "Oauth Apps", usedPercent: 12, remainingPercent: 88 }),
    ]);
    expect(parsed.models).toEqual([]);
  });

  it("classifies Codex windows by duration and does not stuff a 30-day window into weekly", () => {
    const parsed = parseCodexUsage({
      plan_type: "plus",
      access_token: SECRET,
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
      },
      additional_rate_limits: [
        { used_percent: 5, limit_window_seconds: 30 * 86400, reset_at: 1_800_000_000_000 },
      ],
    });
    expect(parsed.plan).toBe("plus");
    expect(parsed.fiveHour).toMatchObject({
      available: true,
      usedPercent: 10,
      remainingPercent: 90,
      resetsAt: new Date(1_800_000_000_000).toISOString(),
    });
    expect(parsed.weekly).toMatchObject({ available: true, usedPercent: 40, remainingPercent: 60 });
    expect(parsed.extra).toEqual([
      expect.objectContaining({
        label: "30-day",
        usedPercent: 5,
        remainingPercent: 95,
        resetsAt: new Date(1_800_000_000_000).toISOString(),
      }),
    ]);
    expect(parsed.models).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("keeps Codex model windows separate from the account plan", () => {
    const parsed = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
            secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
          },
        },
      ],
    });
    expect(parsed.fiveHour.usedPercent).toBe(10);
    expect(parsed.weekly.usedPercent).toBe(40);
    expect(parsed.models).toEqual([
      {
        name: "GPT-5.3-Codex-Spark",
        windows: [
          expect.objectContaining({ label: "5-hour", usedPercent: 5, remainingPercent: 95 }),
          expect.objectContaining({ label: "Weekly", usedPercent: 12, remainingPercent: 88 }),
        ],
      },
    ]);
  });

  it("reports Grok weekly credits without inventing a 5-hour window", () => {
    const parsed = parseGrokUsage(
      {
        access_token: SECRET,
        config: {
          creditUsagePercent: 8,
          currentPeriod: { type: "WEEK", start: "2026-09-26T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
          productUsage: [
            { product: "GrokBuild", usagePercent: 8 },
            { product: "GrokChat", usagePercent: 2 },
          ],
        },
      },
      {
        config: {
          onDemandCap: { val: 100 },
          onDemandUsed: { val: 40 },
          currentPeriod: { type: "MONTH", end: "2026-10-26T00:00:00.000Z" },
        },
      },
      { settings: { subscription_tier_display: "SuperGrok", access_token: SECRET } },
    );
    expect(parsed.plan).toBe("SuperGrok");
    expect(parsed.fiveHour).toEqual({ available: false, remainingPercent: null, usedPercent: null, resetsAt: null });
    expect(parsed.weekly).toMatchObject({
      available: true,
      usedPercent: 8,
      remainingPercent: 92,
      resetsAt: "2026-10-03T00:00:00.000Z",
    });
    expect(parsed.extra).toEqual([
      expect.objectContaining({ label: "Monthly", usedPercent: 40, remainingPercent: 60 }),
    ]);
    expect(parsed.models).toEqual([
      { name: "Grok Build", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 8, remainingPercent: 92 })] },
      { name: "Grok Chat", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 2, remainingPercent: 98 })] },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });
});

describe("plan usage fetcher", () => {
  it("does not call fetch when the Claude token is expired", async () => {
    const fetchImpl = vi.fn<PlanFetch>();
    const configDir = join(tmpdir(), "omb-plan-usage-claude");
    const reads: string[] = [];
    const report = await fetchPlanUsage([account("claude", { id: "work", name: "Work Claude", configDir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: (path) => {
          reads.push(path);
          return JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: NOW - 60_000 } });
        },
      }),
    });
    expect(reads.map((path) => path.replaceAll("\\", "/"))).toEqual([
      `${configDir.replaceAll("\\", "/")}/.credentials.json`,
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.providers).toEqual([
      expect.objectContaining({ id: "work", name: "Work Claude", driver: "claude", ok: false, error: "Sign in again in Claude" }),
    ]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("reads a Claude keychain token when the credentials file has none", async () => {
    const token = "claude-keychain-fixture-token";
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const services: string[] = [];
    const report = await fetchPlanUsage([account("claude")], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readClaudeKeychain: async (service) => {
          services.push(service);
          return service === "Claude Code-credentials"
            ? JSON.stringify({ claudeAiOauth: { accessToken: token } })
            : null;
        },
      }),
    });
    expect(services).toEqual(["Claude Code-credentials"]);
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("asks the keychain only for the custom config dir service", async () => {
    const token = "claude-keychain-other-token";
    const configDir = normalize(join(tmpdir(), "omb-plan-usage-claude-other"));
    const suffixed = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const services: string[] = [];
    const report = await fetchPlanUsage([account("claude", { configDir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readClaudeKeychain: (service) => {
          services.push(service);
          return service === suffixed
            ? JSON.stringify({ claudeAiOauth: { accessToken: token } })
            : null;
        },
      }),
    });
    expect(services[0]).toBe(suffixed);
    expect(services).toEqual([suffixed]);
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("does not use the default Claude keychain login for a custom config dir", async () => {
    const defaultToken = "claude-keychain-default-token";
    const configDir = normalize(join(tmpdir(), "omb-plan-usage-claude-custom"));
    const suffixed = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({}));
    const services: string[] = [];
    const report = await fetchPlanUsage([account("claude", { id: "work", name: "Work Claude", configDir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readClaudeKeychain: (service) => {
          services.push(service);
          return service === "Claude Code-credentials"
            ? JSON.stringify({ claudeAiOauth: { accessToken: defaultToken } })
            : null;
        },
      }),
    });
    expect(services).toEqual([suffixed]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.providers[0]).toMatchObject({ ok: false, error: "Sign in again in Claude" });
    expect(JSON.stringify(report)).not.toContain(defaultToken);
  });

  it("turns a 401 into ok:false without throwing and still returns the other provider", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async (url) => {
      if (url.includes("anthropic.com")) return jsonResponse(SECRET, 401);
      return jsonResponse({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
        },
      });
    });
    const report = await fetchPlanUsage(
      [account("claude"), account("codex")],
      {
        fetch: fetchImpl,
        now: () => NOW,
        credentials: {
          read: (entry) => ({ token: SECRET, accountId: entry.driver === "codex" ? "acct-1" : null, expired: false }),
        },
      },
    );
    expect(report.providers.map((provider) => [provider.driver, provider.ok, provider.error])).toEqual([
      ["claude", false, "Sign in again in Claude"],
      ["codex", true, null],
    ]);
    expect(report.providers[1]?.fiveHour.remainingPercent).toBe(90);
    expect(report.providers[1]?.weekly.remainingPercent).toBe(60);
    const codexCall = fetchImpl.mock.calls.find((call) => call[0].includes("chatgpt.com"));
    expect(codexCall?.[1].headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(codexCall?.[1].headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("reads a Grok login map, skips expired entries, and ignores a settings failure", async () => {
    const fresh = "grok-fresh-fixture-token";
    const stale = "grok-stale-fixture-token";
    const fetchImpl = vi.fn<PlanFetch>(async (url) => {
      if (url.includes("format=credits")) {
        return jsonResponse({
          config: { creditUsagePercent: 8, currentPeriod: { type: "WEEK", end: "2026-10-03T00:00:00.000Z" } },
        });
      }
      if (url.endsWith("/v1/settings")) return jsonResponse("nope", 500);
      return jsonResponse({ config: { creditUsagePercent: 40, currentPeriod: { type: "MONTH", end: "2026-10-26T00:00:00.000Z" } } });
    });
    const report = await fetchPlanUsage([account("grok", { name: "Grok" })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => JSON.stringify({
          old: { key: stale, expires_at: NOW - 60_000 },
          current: { key: fresh, expires_at: NOW + 60_000 },
        }),
      }),
    });
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${fresh}`);
    expect(fetchImpl.mock.calls[0]?.[1].headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(report.providers[0]).toMatchObject({
      ok: true,
      error: null,
      plan: null,
      fiveHour: { available: false },
      weekly: { available: true, remainingPercent: 92, usedPercent: 8 },
    });
    expect(report.providers[0]?.extra[0]).toMatchObject({ label: "Monthly", remainingPercent: 60 });
    expect(JSON.stringify(report)).not.toContain(fresh);
    expect(JSON.stringify(report)).not.toContain(stale);
  });

  it("caches a report for 45 seconds unless refresh is set", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const accounts = [account("claude")];
    const credentials = { read: () => ({ token: SECRET, accountId: null, expired: false }) };
    await loadPlanUsage({ accounts, now: NOW, fetch: fetchImpl, credentials });
    await loadPlanUsage({ accounts, now: NOW + 10_000, fetch: fetchImpl, credentials });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await loadPlanUsage({ accounts, refresh: true, now: NOW + 11_000, fetch: fetchImpl, credentials });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await loadPlanUsage({ accounts, now: NOW + 11_000 + 45_000, fetch: fetchImpl, credentials });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not share the cache when GROK_HOME changes", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const credentials = { read: () => ({ token: SECRET, accountId: null, expired: false }) };
    await loadPlanUsage({
      accounts: [account("claude", { id: "same", environment: { GROK_HOME: "/tmp/one" } })],
      now: NOW,
      fetch: fetchImpl,
      credentials,
    });
    await loadPlanUsage({
      accounts: [account("claude", { id: "same", environment: { GROK_HOME: "/tmp/two" } })],
      now: NOW + 1_000,
      fetch: fetchImpl,
      credentials,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lists configured Claude, Codex, and Grok accounts and skips other engines", () => {
    expect(planAccountsFromInstances({
      claude: { driver: "claudeAgent", displayName: "  Personal Claude  ", config: { configDir: "/tmp/claude" } },
      codex: { driver: "codex" },
      grok: { driver: "grokAgent", environment: { GROK_HOME: "/tmp/grok" } },
      cursor: { driver: "cursorAgent", displayName: "Cursor" },
      api: { driver: "grok", displayName: "Grok API" },
    })).toEqual([
      { id: "claude", name: "Personal Claude", driver: "claude", environment: {}, configDir: "/tmp/claude" },
      { id: "codex", name: "Codex", driver: "codex", environment: {} },
      { id: "grok", name: "Grok", driver: "grok", environment: { GROK_HOME: "/tmp/grok" } },
    ]);
  });
});
