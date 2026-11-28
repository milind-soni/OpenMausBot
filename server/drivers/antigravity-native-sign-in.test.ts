import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanFetch } from "../plan-usage.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { clearNativeTokenWakeHolds, defaultNativeSignInStore, ensureNativeAccessToken, nativeAccessToken, readNativeAccessToken, type NativeSignInStore } from "./antigravity-native-sign-in.ts";
import { antigravityNativePlanUsage } from "./antigravity-usage-limits.ts";

const NOW = Date.parse("2026-11-23T04:40:00Z");

const stored = (expiry: string, accessToken = "native-access") => JSON.stringify({
  token: { access_token: accessToken, token_type: "Bearer", refresh_token: "native-refresh", expiry, expires_in: 3599 },
  auth_method: "consumer",
  id_token_email: "person@example.com",
});
const valid = stored("2026-11-23T13:36:53.008002+08:00");

describe("the access token of the native CLI's stored sign-in", () => {
  it("is read from the profile's plain file", () => {
    expect(nativeAccessToken(valid, NOW)).toBe("native-access");
  });

  it("is none once it has expired or has a minute or less left", () => {
    expect(nativeAccessToken(stored("2026-11-23T04:39:00Z"), NOW)).toBeNull();
    expect(nativeAccessToken(stored("2026-11-23T04:41:00Z"), NOW)).toBeNull();
    expect(nativeAccessToken(stored("2026-11-23T04:41:01Z"), NOW)).toBe("native-access");
  });

  it("is none for a sign-in without a token or an expiry, or that is not JSON", () => {
    expect(nativeAccessToken(null, NOW)).toBeNull();
    expect(nativeAccessToken("not json", NOW)).toBeNull();
    expect(nativeAccessToken("{}", NOW)).toBeNull();
    expect(nativeAccessToken(JSON.stringify({ token: { access_token: "native-access" } }), NOW)).toBeNull();
    expect(nativeAccessToken(stored("2026-11-23T13:36:53Z", ""), NOW)).toBeNull();
  });
});

// The app starts the CLI as over SSH and with file token storage, so each account's sign-in is its profile's file and
// the usage report reads only that file.
describe("which stored sign-in's access token is used", () => {
  const profileFile = join(antigravityProfileDirectory("native"), "antigravity-acp", "antigravity-oauth-token");
  const store = (file: string | null) => {
    const readText = vi.fn(async (path: string) => path === profileFile ? file : null);
    const value: NativeSignInStore = { readText };
    return { value, readText };
  };
  const live = (accessToken: string) => stored("2026-11-23T05:30:00Z", accessToken);
  const dead = (accessToken: string) => stored("2026-11-23T04:30:00Z", accessToken);

  it("is the account's own profile file's, whatever the server's environment says", async () => {
    for (const env of [{ HOME: "/Users/person" }, { HOME: "/Users/person", SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }]) {
      const { value, readText } = store(live("file-access"));
      expect(await readNativeAccessToken("native", env, NOW, value)).toBe("file-access");
      expect(readText).toHaveBeenCalledWith(profileFile);
    }
    expect(Object.keys(defaultNativeSignInStore())).toEqual(["readText"]);
  });

  it("is none when the stored token has expired or there is none, so a file the CLI stopped writing soon shows nothing", async () => {
    expect(await readNativeAccessToken("native", {}, NOW, store(dead("file-access")).value)).toBeNull();
    expect(await readNativeAccessToken("native", {}, NOW, store(null).value)).toBeNull();
  });
});

describe("waking a stale native-CLI sign-in so plan usage can still read it", () => {
  const profileFile = join(antigravityProfileDirectory("native"), "antigravity-acp", "antigravity-oauth-token");
  const store = (file: () => string | null) => {
    const readText = vi.fn(async (path: string) => path === profileFile ? file() : null);
    const value: NativeSignInStore = { readText };
    return { value, readText };
  };
  const live = (accessToken = "fresh-access") => stored("2026-11-23T05:30:00Z", accessToken);
  const dead = stored("2026-11-23T04:30:00Z", "stale-access");

  afterEach(() => clearNativeTokenWakeHolds());

  it("does not start the CLI when the access token is still live, or when the file is gone", async () => {
    const wake = vi.fn(async () => { throw new Error("should not wake"); });
    expect(await ensureNativeAccessToken("native", {}, NOW, { store: store(() => live("native-access")).value, wake })).toBe("native-access");
    expect(await ensureNativeAccessToken("native", {}, NOW, { store: store(() => null).value, wake })).toBeNull();
    expect(wake).not.toHaveBeenCalled();
  });

  it("asks the CLI to refresh its own file when the access token has expired, then reads the new token", async () => {
    let file: string | null = dead;
    const wake = vi.fn(async () => { file = live(); });
    expect(await ensureNativeAccessToken("native", { HOME: "/Users/person" }, NOW, { store: store(() => file).value, wake, clock: () => NOW })).toBe("fresh-access");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("native", { HOME: "/Users/person" });
    expect(JSON.stringify(wake.mock.calls)).not.toMatch(/native-refresh|stale-access|fresh-access/);
  });

  it("holds a failed wake for a minute, then retries", async () => {
    const wake = vi.fn(async () => { throw new Error("cli missing"); });
    const value = store(() => dead).value;
    expect(await ensureNativeAccessToken("native", {}, NOW, { store: value, wake, clock: () => NOW })).toBeNull();
    expect(await ensureNativeAccessToken("native", {}, NOW + 59_000, { store: value, wake, clock: () => NOW + 59_000 })).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await ensureNativeAccessToken("native", {}, NOW + 60_000, { store: value, wake, clock: () => NOW + 60_000 })).toBeNull();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight wake across concurrent reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let file: string | null = dead;
    const wake = vi.fn(async () => { await gate; file = live(); });
    const value = store(() => file).value;
    const first = ensureNativeAccessToken("native", {}, NOW, { store: value, wake, clock: () => NOW });
    const second = ensureNativeAccessToken("native", {}, NOW, { store: value, wake, clock: () => NOW });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toBe("fresh-access");
    expect(await second).toBe("fresh-access");
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("keeps the wake registered until the hold decision, so a read during the post-wake reread does not wake again", async () => {
    let releaseReread!: () => void;
    const rereadGate = new Promise<void>((resolve) => { releaseReread = resolve; });
    let reads = 0;
    const value: NativeSignInStore = {
      readText: async () => {
        reads += 1;
        // The post-wake reread (3rd read) hangs, simulating the window between the wake settling and the hold
        // being installed, where a concurrent read used to find neither a pending wake nor a hold.
        if (reads === 3) await rereadGate;
        return dead;
      },
    };
    const wake = vi.fn(async () => undefined);
    const first = ensureNativeAccessToken("native", {}, NOW, { store: value, wake });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    const second = ensureNativeAccessToken("native", {}, NOW, { store: value, wake });
    releaseReread();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("times a failed wake's hold from when the wake finishes, not when it started", async () => {
    let clockNow = NOW;
    const clock = () => clockNow;
    const wake = vi.fn(async () => { clockNow += 65_000; throw new Error("slow cli"); });
    const value = store(() => dead).value;
    expect(await ensureNativeAccessToken("native", {}, clockNow, { store: value, wake, clock })).toBeNull();
    // The hold must start at NOW + 65_000 (completion), so NOW + 124_999 is still held and NOW + 125_000 retries.
    expect(await ensureNativeAccessToken("native", {}, clockNow + 59_999, { store: value, wake, clock })).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    clockNow += 60_000;
    expect(await ensureNativeAccessToken("native", {}, clockNow, { store: value, wake, clock })).toBeNull();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("returns nothing when the CLI runs but the file stays stale", async () => {
    const wake = vi.fn(async () => undefined);
    expect(await ensureNativeAccessToken("native", {}, NOW, { store: store(() => dead).value, wake })).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

describe("a native-CLI account's limits", () => {
  const summary = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75, resetTime: "2026-11-23T08:21:16Z", description: "used" },
    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5, resetTime: "2026-11-28T09:29:26Z", description: "used" },
  ] }] };
  const fixture = () => {
    const requests: Array<{ url: string; authorization: string | undefined; body: string | undefined }> = [];
    const fetch: PlanFetch = async (url, init) => {
      requests.push({ url, authorization: init.headers.Authorization, body: init.body });
      return { ok: true, status: 200, text: async () => JSON.stringify(summary) };
    };
    return { requests, deps: { fetch, now: () => NOW } };
  };

  it("are Google's quota summary for the CLI's access token, asked without a project and without refreshing", async () => {
    const { requests, deps } = fixture();
    const readAccessToken = vi.fn(async () => "native-access");
    const usage = await antigravityNativePlanUsage("native", { HOME: "/Users/person" }, deps, readAccessToken);
    expect(usage).toMatchObject({ fiveHour: { available: true, usedPercent: 25 }, weekly: { available: true, usedPercent: 50 } });
    expect(readAccessToken).toHaveBeenCalledWith("native", expect.objectContaining({ HOME: "/Users/person" }), NOW);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/v1internal:retrieveUserQuotaSummary", "/v1internal:retrieveUserQuotaSummary"]);
    expect(requests.every((request) => request.authorization === "Bearer native-access" && request.body === "{}")).toBe(true);
    expect(JSON.stringify(usage)).not.toMatch(/native-access|native-refresh|person@example\.com/);
  });

  it("are no row, and ask Google nothing, without a live token or once the switch is off", async () => {
    const { requests, deps } = fixture();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => null)).toBeNull();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => { throw new Error("keychain"); })).toBeNull();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => "native-access", false)).toBeNull();
    expect(requests).toEqual([]);
  });
});
