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
  parseOpenCodeUsage,
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

/** A plan account for one driver, named as the panel names it. */
function account(driver: PlanAccount["driver"], extras: Partial<PlanAccount> = {}): PlanAccount {
  const name = driver === "claude" ? "Claude" : driver === "codex" ? "Codex" : driver === "opencode" ? "OpenCode" : "Grok";
  return {
    id: driver,
    name,
    driver,
    environment: {},
    ...extras,
  };
}

describe("plan usage parsers", () => {
  describe("a Claude budget in money", () => {
    const enterprise = {
      five_hour: null,
      seven_day: null,
      spend: { enabled: true, used: { amount_minor: 4_631, currency: "USD", exponent: 2 }, limit: { amount_minor: 50_000, currency: "USD", exponent: 2 }, percent: 9 },
      extra_usage: { is_enabled: true, used_credits: 4_631, monthly_limit: 50_000, utilization: 9.262, currency: "USD", decimal_places: 2 },
    };
    const line = (label: string, used: number, spend?: object) => ({ label, usedPercent: expect.closeTo(used, 2), remainingPercent: expect.closeTo(100 - used, 2), resetsAt: null, ...(spend ? { spend } : {}) });

    it("shows an Enterprise seat's monthly spend with its amounts, once", () => {
      const parsed = parseClaudeUsage(enterprise);
      expect(parsed.extra).toEqual([line("Monthly spend", 9.262, { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 })]);
      expect(parsed.fiveHour.available).toBe(false);
      expect(parsed.weekly.available).toBe(false);
    });

    it("reads the budget from extra usage when the spend block is missing, off or its money does not add up", () => {
      const fallback = line("Monthly spend", 9.262, { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 });
      expect(parseClaudeUsage({ extra_usage: enterprise.extra_usage }).extra).toEqual([fallback]);
      expect(parseClaudeUsage({ ...enterprise, spend: { ...enterprise.spend, enabled: false } }).extra).toEqual([fallback]);
      const unmatched = { ...enterprise.spend, used: { amount_minor: 9_000, currency: "USD", exponent: 2 } };
      expect(parseClaudeUsage({ ...enterprise, spend: { ...unmatched, limit: { amount_minor: 50_000, currency: "EUR", exponent: 2 } } }).extra).toEqual([fallback]);
      expect(parseClaudeUsage({ ...enterprise, spend: { ...unmatched, limit: { amount_minor: 50_000, currency: "USD", exponent: 3 } } }).extra).toEqual([fallback]);
    });

    it("prefers the spend block over extra usage, and needs nothing else", () => {
      const spend = { ...enterprise.spend, used: { amount_minor: 25_000, currency: "USD", exponent: 2 } };
      const line50 = line("Monthly spend", 50, { usedMinor: 25_000, limitMinor: 50_000, currency: "USD", exponent: 2 });
      expect(parseClaudeUsage({ ...enterprise, spend }).extra).toEqual([line50]);
      expect(parseClaudeUsage({ spend }).extra).toEqual([line50]);
    });

    it("takes the digits from the currency when Claude does not say", () => {
      const { decimal_places: _digits, ...usd } = enterprise.extra_usage;
      expect(parseClaudeUsage({ extra_usage: usd }).extra[0]?.spend?.exponent).toBe(2);
      expect(parseClaudeUsage({ extra_usage: { ...usd, currency: "JPY" } }).extra[0]?.spend?.exponent).toBe(0);
    });

    it("keeps only the percent without usable amounts", () => {
      expect(parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 30, monthly_limit: null, used_credits: null } }).extra).toEqual([line("Monthly spend", 30)]);
      expect(parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 30, monthly_limit: 500, used_credits: 150, currency: "not money" } }).extra).toEqual([line("Monthly spend", 30)]);
      expect(parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 30, monthly_limit: 0, used_credits: 0, currency: "USD" } }).extra).toEqual([line("Monthly spend", 30)]);
    });

    it("calls it extra usage on a plan with rolling windows", () => {
      const parsed = parseClaudeUsage({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null }, extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 1_000, utilization: 50, currency: "USD" } });
      expect(parsed.extra).toEqual([line("Extra Usage", 50, { usedMinor: 500, limitMinor: 1_000, currency: "USD", exponent: 2 })]);
    });

    it("shows nothing for a budget that is off", () => {
      expect(parseClaudeUsage({ extra_usage: { ...enterprise.extra_usage, is_enabled: false } }).extra).toEqual([]);
      expect(parseClaudeUsage({ spend: { ...enterprise.spend, enabled: false } }).extra).toEqual([]);
    });
  });

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

/** OpenCode Go's meters as the panel shows them: the running window, the week and the month. */
describe("an OpenCode Go allowance", () => {
  const body = {
    usage: {
      rolling: { status: "ok", percent: 5, resetsAt: "2026-11-04T22:20:18.000Z" },
      weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-09T00:00:00.000Z" },
      monthly: { status: "ok", percent: 17, resetsAt: "2026-11-24T21:32:14.000Z" },
    },
  };

  it("reads the running window, the week and the month", () => {
    const parsed = parseOpenCodeUsage(body);
    expect(parsed.plan).toBe("Go");
    expect(parsed.fiveHour).toEqual({ available: true, usedPercent: 5, remainingPercent: 95, resetsAt: "2026-11-04T22:20:18.000Z" });
    expect(parsed.weekly).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
    expect(parsed.extra).toEqual([{ label: "Monthly", usedPercent: 17, remainingPercent: 83, resetsAt: "2026-11-24T21:32:14.000Z" }]);
  });

  it("says nothing it was not given", () => {
    expect(parseOpenCodeUsage({}).plan).toBeNull();
    expect(parseOpenCodeUsage({ usage: {} }).fiveHour.available).toBe(false);
    expect(parseOpenCodeUsage({ usage: { rolling: { status: "ok", percent: "5" } } }).fiveHour.available).toBe(false);
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
      claude: { driver: "claudeAgent", displayName: "  Personal Claude  ", config: { configDir: "/tmp/claude", usageMeter: true } },
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

/** An OpenCode instance becomes an account under the driver the panel knows. */
  it("lists an OpenCode instance under the key its environment carries", () => {
    expect(planAccountsFromInstances({
      open: { driver: "opencodeGo", environment: { OPENCODE_API_KEY: SECRET } },
    })).toEqual([{ id: "open", name: "OpenCode", driver: "opencode", environment: { OPENCODE_API_KEY: SECRET } }]);
  });

/** The saved key is the Bearer, and the three meters land in their slots. */
  it("reads OpenCode Go's allowance with the key saved on the instance", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      usage: {
        rolling: { status: "ok", percent: 5, resetsAt: "2026-11-04T22:20:18.000Z" },
        weekly: { status: "ok", percent: 15, resetsAt: "2026-11-09T00:00:00.000Z" },
        monthly: { status: "ok", percent: 17, resetsAt: "2026-11-24T21:32:14.000Z" },
      },
    }));
    const report = await fetchPlanUsage([account("opencode", { environment: { OPENCODE_API_KEY: SECRET } })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({ now: () => NOW, env: {}, readText: () => null }),
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(report.providers[0]).toMatchObject({
      driver: "opencode",
      ok: true,
      error: null,
      plan: "Go",
      fiveHour: { available: true, usedPercent: 5, remainingPercent: 95 },
      weekly: { available: true, usedPercent: 15 },
    });
    expect(report.providers[0]?.extra[0]).toMatchObject({ label: "Monthly", usedPercent: 17 });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

/** With no key, the CLI login is used, and the Go entry wins over the Zen one. */
  it("takes the CLI's OpenCode Go login when no key is saved, before the Zen one", async () => {
    const goLogin = "opencode-go-fixture-login";
    const zenLogin = "opencode-zen-fixture-login";
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({ usage: { rolling: { status: "ok", percent: 4, resetsAt: null } } }));
    const auth = (entries: Record<string, unknown>) => ({ OPENCODE_AUTH_CONTENT: JSON.stringify(entries) });
    await fetchPlanUsage([
      account("opencode", { id: "go", environment: auth({ opencode: { type: "key", key: zenLogin }, "opencode-go": { type: "oauth", access: goLogin, expires: NOW + 600_000 } }) }),
      account("opencode", { id: "zen", environment: auth({ opencode: { type: "key", key: zenLogin } }) }),
    ], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({ now: () => NOW, env: {}, readText: () => null }),
    });
    expect(fetchImpl.mock.calls.map((call) => call[1].headers.Authorization)).toEqual([`Bearer ${goLogin}`, `Bearer ${zenLogin}`]);
  });

  /** The row reads the login the CLI keeps when the environment carries no key and no auth content. */
  it("falls back to the CLI's auth.json when OPENCODE_AUTH_CONTENT is empty", async () => {
    const login = "opencode-file-fixture-login";
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({ usage: { rolling: { status: "ok", percent: 2, resetsAt: null } } }));
    await fetchPlanUsage([account("opencode", { environment: { OPENCODE_AUTH_CONTENT: "   " } })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({ now: () => NOW, env: { HOME: tmpdir() }, readText: () => JSON.stringify({ "opencode-go": { access: login } }) }),
    });
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${login}`);
  });

  /** A 200 that carries no meter is an unreadable answer, not an empty allowance. */
  it("does not call a 200 without meters a working row", async () => {
    const report = await fetchPlanUsage([account("opencode", { environment: { OPENCODE_API_KEY: SECRET } })], {
      fetch: async () => jsonResponse({}),
      now: () => NOW,
      credentials: fileCredentialReader({ now: () => NOW, env: {}, readText: () => null }),
    });
    expect(report.providers[0]).toMatchObject({ ok: false, error: "OpenCode returned an unexpected usage response" });
  });

/** No Go plan is a quiet row; a refused key is named. */
  it("keeps the OpenCode row when there is no Go plan, and names a refused key", async () => {
    const credentials = fileCredentialReader({ now: () => NOW, env: {}, readText: () => null });
    const instances = [account("opencode", { environment: { OPENCODE_API_KEY: SECRET } })];
    const noGo = await fetchPlanUsage(instances, {
      fetch: async () => jsonResponse({ _tag: "Forbidden" }, 403),
      now: () => NOW,
      credentials,
    });
    expect(noGo.providers[0]).toMatchObject({ ok: true, error: null, plan: null, fiveHour: { available: false }, extra: [] });

    const refused = await fetchPlanUsage(instances, {
      fetch: async () => jsonResponse({ error: "unauthorized" }, 401),
      now: () => NOW,
      credentials,
    });
    expect(refused.providers[0]).toMatchObject({ ok: false, error: "OpenCode refused the saved credentials" });
  });

  it("reads no usage for a ChatGPT-plan provider, whose sign-in is not the shared Codex login", async () => {
    // Reading ~/.codex/auth.json for it reported (and held) the default Codex account's limit on a different account.
    const accounts = planAccountsFromInstances({
      codex: { driver: "codex" },
      chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    });
    // Still listed, so a refusal-based hold names it properly.
    expect(accounts).toEqual([
      { id: "codex", name: "Codex", driver: "codex", environment: {} },
      { id: "chatgpt", name: "ChatGPT plan", driver: "codex", environment: {}, noUsage: true },
    ]);
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({ rate_limit: { primary_window: { used_percent: 100 } } }));
    const report = await fetchPlanUsage(accounts, {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: { read: () => ({ token: SECRET, accountId: null, expired: false }) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.providers.map((row) => row.id)).toEqual(["codex"]);
  });

  it("reads no Claude login unless the instance turns its usage meter on", async () => {
    const accounts = planAccountsFromInstances({
      claude: { driver: "claudeAgent" },
      metered: { driver: "claudeAgent", displayName: "Metered", config: { usageMeter: true } },
    });
    expect(accounts).toEqual([
      { id: "claude", name: "Claude", driver: "claude", environment: {}, noUsage: true },
      { id: "metered", name: "Metered", driver: "claude", environment: {} },
    ]);
    const read = vi.fn((_account: PlanAccount) => ({ token: SECRET, accountId: null, expired: false }));
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({}));
    const report = await fetchPlanUsage(accounts, { fetch: fetchImpl, now: () => NOW, credentials: { read } });
    expect(read.mock.calls.map(([account]) => account.id)).toEqual(["metered"]);
    expect(report.providers.map((row) => row.id)).toEqual(["metered"]);
  });
});
