// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityUsageLimits.test.ts (the quota
//     fixtures and the cases of the limits reader).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPlanUsageCache, fetchPlanUsage, planAccountsFromInstances, type PlanFetch } from "../plan-usage.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { antigravityTokenPath } from "./antigravity-acp.ts";
import {
  antigravityPlanUsage,
  antigravityPlanWindows,
  clearAntigravityUsageAccess,
  readAntigravityUsageWindows,
} from "./antigravity-usage-limits.ts";

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.96, resetTime: "2026-10-12T19:41:43Z" },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.91, resetTime: "2026-10-09T16:06:01Z" },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0, resetTime: "2026-10-10T15:28:22Z" },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 0.44, resetTime: "2026-10-09T16:06:30Z" },
      ],
    },
  ],
};

const scratch: string[] = [];

interface FixtureOptions {
  summary?: unknown;
  /** Per-host quota summaries; hosts not listed fall back to `summary`. */
  summaryByHost?: Record<string, unknown>;
  models?: unknown;
  summaryStatus?: number;
  summaryStatusByHost?: Record<string, number>;
  tokenStatus?: number;
  /** Requests whose address holds one of these never answer, and ignore their signal. */
  hangs?: string[];
  missingToken?: boolean;
  now?: number;
  /** The clock after the token refresh answers. */
  refreshedAt?: number;
}

function fixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-usage-"));
  scratch.push(directory);
  mkdirSync(join(directory, "antigravity-acp"));
  const tokenPath = join(directory, "antigravity-acp", "acp_token.json");
  const writeToken = (refreshToken: string) => writeFileSync(tokenPath, JSON.stringify({
    client_id: "client-id", client_secret: "client-secret", refresh_token: refreshToken, project_id: "project-id",
  }));
  if (!options.missingToken) writeToken("refresh-a");
  const requests: Array<{ url: string; body: string }> = [];
  let clock = options.now ?? Date.parse("2026-10-09T12:00:00Z");
  const respond = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  const fetch: PlanFetch = async (url, init) => {
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("POST");
    requests.push({ url, body: init.body ?? "" });
    if (options.hangs?.some((part) => url.includes(part))) return new Promise(() => {});
    if (url.endsWith("/token")) {
      expect(new URLSearchParams(init.body).get("grant_type")).toBe("refresh_token");
      if (options.refreshedAt !== undefined) clock = options.refreshedAt;
      return respond({ access_token: "access-token", expires_in: 3600 }, options.tokenStatus ?? 200);
    }
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(JSON.parse(init.body!)).toEqual({ project: "project-id" });
    expect(init.headers["User-Agent"]).toMatch(/^antigravity\/hub\/2\.24\.0 /);
    const host = new URL(url).host;
    return url.endsWith(":retrieveUserQuotaSummary")
      ? respond(options.summaryByHost?.[host] ?? options.summary ?? summary, options.summaryStatusByHost?.[host] ?? options.summaryStatus ?? 200)
      : respond(options.models ?? { models: {} });
  };
  const deps = { fetch, now: () => clock };
  return { deps, requests, writeToken, tokenPath, windows: () => readAntigravityUsageWindows(tokenPath, deps), advance: (ms: number) => { clock += ms; } };
}

const at = (iso: string) => Date.parse(iso);
const resets = (windows: Array<{ id: string; resetsAt?: string }>) =>
  Object.fromEntries(windows.map(({ id, resetsAt }) => [id, resetsAt]));

beforeEach(() => {
  clearAntigravityUsageAccess();
  clearPlanUsageCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("Antigravity subscription limits", () => {
  it("omits rolling resets for untouched summary buckets and keeps used Gemini resets", async () => {
    const { windows } = fixture({
      now: at("2026-10-21T10:16:04Z"),
      summary: {
        groups: [{
          buckets: [
            { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-10-21T15:16:05Z" },
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T10:16:05Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.848104, resetTime: "2026-10-21T13:29:53Z",
              description: "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 13 minutes." },
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9620177, resetTime: "2026-10-28T08:29:53Z",
              description: "You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours." },
          ],
        }],
      },
    });
    const byId = new Map((await windows()).map((window) => [window.id, window]));
    expect(byId.get("3p-5h")).toEqual({ id: "3p-5h", family: "Claude & GPT (shared)", name: "5-hour", kind: "session", usedPercent: 0, windowDurationMins: 300 });
    expect(byId.get("3p-weekly")).toEqual({ id: "3p-weekly", family: "Claude & GPT (shared)", name: "Weekly", kind: "weekly", usedPercent: 0, windowDurationMins: 10080 });
    expect(byId.get("gemini-5h")?.resetsAt).toBe("2026-10-21T13:29:53.000Z");
    expect(byId.get("gemini-weekly")?.resetsAt).toBe("2026-10-28T08:29:53.000Z");
  });

  it("uses summary request time after authentication for the reset tolerance", async () => {
    const { windows } = fixture({
      now: at("2026-10-21T10:16:02Z"),
      refreshedAt: at("2026-10-21T10:16:04Z"),
      summary: { buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-10-21T15:17:03Z" }] },
    });
    expect((await windows())[0]?.resetsAt).toBeUndefined();
  });

  it("keeps summary resets with a description, a distant reset, or no quota left", async () => {
    const { windows } = fixture({
      now: at("2026-10-21T10:16:04Z"),
      summary: {
        buckets: [
          { bucketId: "described", window: "5h", remainingFraction: 1, description: "Reported reset", resetTime: "2026-10-21T15:16:04Z" },
          { bucketId: "distant", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T12:16:04Z" },
          { bucketId: "spent", window: "5h", remainingFraction: 0, resetTime: "2026-10-21T15:16:04Z" },
          { bucketId: "overfull", window: "5h", remainingFraction: 1.01, resetTime: "2026-10-21T15:16:04Z" },
          { bucketId: "empty-description", window: "5h", remainingFraction: 1, description: "", resetTime: "2026-10-21T15:16:04Z" },
        ],
      },
    });
    expect(resets(await windows())).toEqual({
      described: "2026-10-21T15:16:04.000Z",
      "empty-description": "2026-10-21T15:16:04.000Z",
      overfull: "2026-10-21T15:16:04.000Z",
      spent: "2026-10-21T15:16:04.000Z",
      distant: "2026-10-28T12:16:04.000Z",
    });
  });

  it("omits summary resets 59 seconds away but keeps resets 61 seconds away", async () => {
    const { windows } = fixture({
      now: at("2026-10-21T10:16:04Z"),
      summary: {
        buckets: [
          { bucketId: "5h-before", window: "5h", remainingFraction: 1, resetTime: "2026-10-21T15:15:05Z" },
          { bucketId: "5h-after", window: "5h", remainingFraction: 1, resetTime: "2026-10-21T15:17:05Z" },
          { bucketId: "5h-edge", window: "5h", remainingFraction: 1, resetTime: "2026-10-21T15:17:04Z" },
          { bucketId: "weekly-after", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T10:17:03Z" },
          { bucketId: "weekly-before", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T10:15:03Z" },
          { bucketId: "weekly-edge", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T10:15:04Z" },
        ],
      },
    });
    expect(resets(await windows())).toEqual({
      "5h-after": "2026-10-21T15:17:05.000Z",
      "5h-before": undefined,
      "5h-edge": undefined,
      "weekly-after": undefined,
      "weekly-before": "2026-10-28T10:15:03.000Z",
      "weekly-edge": undefined,
    });
  });

  it("keeps full model fallback resets even at a full window from the request", async () => {
    const { windows } = fixture({
      now: at("2026-10-21T10:16:04Z"),
      summaryStatus: 404,
      models: { models: { "gemini-a": {
        quotaInfo: { remainingFraction: 1, resetTime: "2026-10-21T15:16:04Z" },
        weeklyQuotaInfo: { remainingFraction: 1, resetTime: "2026-10-28T10:16:04Z" },
      } } },
    });
    expect((await windows()).map(({ id, resetsAt, windowDurationMins }) => ({ id, resetsAt, windowDurationMins })).sort((a, b) => b.id.localeCompare(a.id))).toEqual([
      { id: "gemini-weekly", resetsAt: "2026-10-28T10:16:04.000Z", windowDurationMins: 10080 },
      { id: "gemini-quota", resetsAt: "2026-10-21T15:16:04.000Z", windowDurationMins: undefined },
    ]);
  });

  it("reports separate Gemini and shared Claude/GPT five-hour and weekly limits, refreshing access once", async () => {
    const { windows, requests } = fixture();
    const first = await windows();
    expect(first).toHaveLength(4);
    const byId = new Map(first.map((window) => [window.id, window]));
    expect(byId.get("gemini-weekly")?.usedPercent).toBeCloseTo(4);
    expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(9);
    expect(byId.get("3p-weekly")).toMatchObject({ family: "Claude & GPT (shared)", name: "Weekly", kind: "weekly", usedPercent: 100, windowDurationMins: 10080, resetsAt: "2026-10-10T15:28:22.000Z" });
    expect(byId.get("3p-5h")).toMatchObject({ kind: "session", windowDurationMins: 300 });
    expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(56);
    await windows();
    expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary"))).toHaveLength(4);
    expect(requests.some((request) => request.url.endsWith(":fetchAvailableModels"))).toBe(false);
  });

  it("merges quota groups that only one endpoint reports", async () => {
    const { windows } = fixture({
      summaryByHost: {
        // The daily endpoint can omit Gemini while the other endpoint returns all groups.
        "daily-cloudcode-pa.googleapis.com": { groups: [{ displayName: "Claude and GPT models", buckets: [
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 },
          { bucketId: "3p-5h", window: "5h", remainingFraction: 0.3 },
        ] }] },
      },
    });
    const all = await windows();
    expect(all.map((window) => window.id).sort()).toEqual(["3p-5h", "3p-weekly", "gemini-5h", "gemini-weekly"]);
    const byId = new Map(all.map((window) => [window.id, window]));
    expect(byId.get("gemini-weekly")).toMatchObject({ family: "Gemini", name: "Weekly" });
    expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(70);
    expect(byId.get("3p-weekly")?.usedPercent).toBe(50);
  });

  it("reports a personal account's quota from the daily endpoint it is metered on", async () => {
    const argon = (remainingFraction: number, resetTime: string) => ({
      groups: [{ displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction, resetTime }] }],
    });
    const { windows } = fixture({
      now: at("2026-11-07T12:00:00Z"),
      summaryByHost: {
        "daily-cloudcode-pa.googleapis.com": argon(0.8623059, "2026-11-14T08:41:35Z"),
        "cloudcode-pa.googleapis.com": argon(0, "2026-11-08T18:27:14Z"),
      },
    });
    expect(await windows()).toEqual([
      expect.objectContaining({ id: "gemini-argon-wtu-weekly", usedPercent: expect.closeTo(13.77, 2), resetsAt: "2026-11-14T08:41:35.000Z" }),
    ]);
  });

  it("labels Argon and Carbon quotas apart from the default Gemini quota", async () => {
    const { windows } = fixture({
      summary: {
        groups: [
          ...summary.groups,
          { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.6 }] },
          { displayName: "Gemini 4 Carbon", buckets: [{ bucketId: "gemini-carbon-wtu-weekly", window: "weekly", remainingFraction: 0.4 }] },
          { displayName: " ", buckets: [{ bucketId: "gemini-carbon-5h", window: "5h", remainingFraction: 0.8 }] },
        ],
      },
    });
    const byId = new Map((await windows()).map((window) => [window.id, window]));
    expect(byId.get("gemini-weekly")).toMatchObject({ family: "Gemini", name: "Weekly" });
    expect(byId.get("gemini-argon-wtu-weekly")).toMatchObject({ family: "Gemini 4 Argon", name: "Weekly" });
    expect(byId.get("gemini-carbon-wtu-weekly")).toMatchObject({ family: "Gemini 4 Carbon", name: "Weekly" });
    expect(byId.get("gemini-carbon-5h")).toMatchObject({ family: "Gemini Carbon", name: "5-hour" });
  });

  it("keeps one endpoint's quotas when the other fails", async () => {
    const { windows } = fixture({ summaryStatusByHost: { "daily-cloudcode-pa.googleapis.com": 503 } });
    expect(await windows()).toHaveLength(4);
  });

  it("re-reads changed credentials and asks for access again after the sign-in was removed", async () => {
    const { deps, requests, writeToken, tokenPath } = fixture();
    const refreshes = () => requests.filter((request) => request.url.endsWith("/token")).length;
    expect(await antigravityPlanUsage("instance", deps, tokenPath)).not.toBeNull();
    writeToken("refresh-b");
    expect(await antigravityPlanUsage("instance", deps, tokenPath)).not.toBeNull();
    expect(refreshes()).toBe(2);
    rmSync(tokenPath);
    const before = requests.length;
    expect(await antigravityPlanUsage("instance", deps, tokenPath)).toBeNull();
    expect(requests).toHaveLength(before);
    writeToken("refresh-b");
    await antigravityPlanUsage("instance", deps, tokenPath);
    expect(refreshes()).toBe(3);
  });

  it("falls back to model quotas without inventing a window duration", async () => {
    const { windows } = fixture({
      summaryStatus: 404,
      models: { models: {
        "gemini-a": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-10T12:00:00Z" } },
        "gemini-b": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-10T12:00:00Z" } },
        "claude-a": { quotaInfo: { remainingFraction: 0.2 } },
      } },
    });
    const all = await windows();
    expect(all).toHaveLength(2);
    expect(all.find((window) => window.id === "gemini-quota")?.usedPercent).toBe(40);
    expect(all.every((window) => window.kind === "other" && window.windowDurationMins === undefined)).toBe(true);
  });

  it("keeps Argon and Carbon apart from Gemini's own allowance in the model quotas", async () => {
    const { windows } = fixture({
      summaryStatus: 404,
      models: { models: {
        "gemini-a": { modelProvider: "MODEL_PROVIDER_GOOGLE", weeklyQuotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-12T12:00:00Z" } },
        "gemini-4-argon": { modelProvider: "MODEL_PROVIDER_GOOGLE", weeklyQuotaInfo: { remainingFraction: 0, resetTime: "2026-10-11T12:00:00Z" } },
        "gemini-4-carbon": { modelProvider: "MODEL_PROVIDER_GOOGLE", weeklyQuotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-13T12:00:00Z" } },
      } },
    });
    const row = antigravityPlanWindows(await windows());
    expect(row.weekly).toMatchObject({ usedPercent: 25, resetsAt: "2026-10-12T12:00:00.000Z" });
    expect(row.models.map((model) => [model.name, model.windows.map((window) => window.usedPercent)])).toEqual([["Gemini Argon", [100]], ["Gemini Carbon", [50]]]);
  });

  it("skips disabled and missing fractions and clamps valid percentages", async () => {
    const { windows } = fixture({
      summary: { buckets: [
        { bucketId: "disabled", remainingFraction: 0, disabled: true },
        { bucketId: "missing", resetTime: "2026-10-10T12:00:00Z" },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 2, resetTime: "invalid" },
      ] },
    });
    expect(await windows()).toEqual([{ id: "gemini-5h", family: "Gemini", name: "5-hour", kind: "session", usedPercent: 0, windowDurationMins: 300 }]);
  });
});

describe("the Antigravity row of the usage report", () => {
  it("leads with Gemini's own 5-hour and weekly windows and lists every other allowance by family", async () => {
    const { windows } = fixture();
    expect(antigravityPlanWindows(await windows())).toEqual({
      plan: null,
      fiveHour: { available: true, usedPercent: expect.closeTo(9, 5), remainingPercent: expect.closeTo(91, 5), resetsAt: "2026-10-09T16:06:01.000Z" },
      weekly: { available: true, usedPercent: expect.closeTo(4, 5), remainingPercent: expect.closeTo(96, 5), resetsAt: "2026-10-12T19:41:43.000Z" },
      extra: [],
      models: [{ name: "Claude & GPT (shared)", windows: [
        { label: "Weekly", usedPercent: 100, remainingPercent: 0, resetsAt: "2026-10-10T15:28:22.000Z" },
        { label: "5-hour", usedPercent: expect.closeTo(56, 5), remainingPercent: expect.closeTo(44, 5), resetsAt: "2026-10-09T16:06:30.000Z" },
      ] }],
    });
    expect(antigravityPlanWindows([{ id: "gemini-quota", family: "Gemini", name: "Reported quota", kind: "other", usedPercent: 40 }])).toMatchObject({
      fiveHour: { available: false }, weekly: { available: false }, models: [{ name: "Gemini", windows: [{ label: "Reported quota", usedPercent: 40, resetsAt: null }] }],
    });
  });

  it.each([
    ["Google refuses the stored sign-in", { tokenStatus: 401 }, 1],
    ["Google cannot be reached for the refresh", { tokenStatus: 503 }, 1],
    ["Google refuses both quota calls", { summaryStatus: 403, models: "nothing" }, 5],
    ["Google reports nothing usable", { summary: { buckets: [] } }, 5],
    ["nobody is signed in", { missingToken: true }, 0],
  ] as Array<[string, FixtureOptions, number]>)("is no row at all, and says nothing, when %s", async (_name, options, calls) => {
    const { deps, requests, tokenPath } = fixture(options);
    const warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error"), log = vi.spyOn(console, "log");
    expect(await antigravityPlanUsage("instance", deps, tokenPath)).toBeNull();
    expect(requests).toHaveLength(calls);
    for (const spy of [warn, error, log]) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["the refresh", ["/token"]],
    ["both quota hosts", ["cloudcode-pa.googleapis.com"]],
    ["one quota host", ["daily-cloudcode-pa.googleapis.com"]],
  ])("gives up on the whole read after one deadline when %s never answers", async (_name, hangs) => {
    const { deps, tokenPath } = fixture({ hangs });
    const started = Date.now();
    const usage = await antigravityPlanUsage("instance", { ...deps, timeoutMs: 300 }, tokenPath);
    expect(Date.now() - started).toBeLessThan(2_000);
    if (hangs[0] === "daily-cloudcode-pa.googleapis.com") expect(usage).not.toBeNull();
    else expect(usage).toBeNull();
  });

  it("does not ask Google again for a sign-in it refused until a quarter of an hour has passed or the sign-in changed", async () => {
    const { deps, requests, tokenPath, writeToken, advance } = fixture({ tokenStatus: 401 });
    for (let read = 0; read < 3; read += 1) expect(await antigravityPlanUsage("instance", deps, tokenPath)).toBeNull();
    expect(requests).toHaveLength(1);
    advance(15 * 60_000 - 1);
    await antigravityPlanUsage("instance", deps, tokenPath);
    expect(requests).toHaveLength(1);
    advance(1);
    await antigravityPlanUsage("instance", deps, tokenPath);
    expect(requests).toHaveLength(2);
    writeToken("refresh-b");
    await antigravityPlanUsage("instance", deps, tokenPath);
    expect(requests).toHaveLength(3);
  });

  it("is no row, and makes no request, once the switch is off", async () => {
    const { deps, requests, tokenPath } = fixture();
    expect(await antigravityPlanUsage("instance", deps, tokenPath, false)).toBeNull();
    expect(requests).toEqual([]);
  });

  it("never returns the sign-in, the access token or the account", async () => {
    const { deps, tokenPath } = fixture();
    expect(JSON.stringify(await antigravityPlanUsage("instance", deps, tokenPath))).not.toMatch(/client-secret|client-id|refresh-a|access-token|project-id/);
  });

  it("joins the report beside the other engines, and is left out when it cannot be read", async () => {
    const instanceId = "antigravity-usage-row";
    const accounts = planAccountsFromInstances({ [instanceId]: { driver: "antigravityAgent", displayName: "", enabled: true, config: {}, environment: {} } } as never);
    expect(accounts).toEqual([{ id: instanceId, name: "Antigravity", driver: "antigravity", environment: {} }]);
    const { deps } = fixture();
    const credentials = { read: () => { throw new Error("the report's own credential reader is not used for Antigravity"); } };
    expect((await fetchPlanUsage(accounts, { ...deps, credentials })).providers).toEqual([]);
    const tokenPath = antigravityTokenPath(instanceId);
    mkdirSync(join(tokenPath, ".."), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify({ client_id: "client-id", client_secret: "client-secret", refresh_token: "refresh-a", project_id: "project-id" }));
    const report = await fetchPlanUsage(accounts, { ...deps, credentials });
    expect(report.providers).toMatchObject([{ id: instanceId, name: "Antigravity", driver: "antigravity", ok: true, error: null, fiveHour: { available: true }, weekly: { available: true } }]);
    expect(JSON.stringify(report)).not.toMatch(/client-secret|refresh-a|access-token/);
  });
});
