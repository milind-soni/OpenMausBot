import { describe, expect, it, vi } from "vitest";

import type { PlanFetch } from "../plan-usage.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { nativeAccessToken, readNativeSignIn, type NativeSignInStore } from "./antigravity-native-sign-in.ts";
import { antigravityNativePlanUsage } from "./antigravity-usage-limits.ts";

const NOW = Date.parse("2026-11-23T04:40:00Z");

const stored = (expiry: string, accessToken = "native-access") => JSON.stringify({
  token: { access_token: accessToken, token_type: "Bearer", refresh_token: "native-refresh", expiry, expires_in: 3599 },
  auth_method: "consumer",
  id_token_email: "person@example.com",
});
const inKeychain = (text: string) => `go-keyring-base64:${Buffer.from(text).toString("base64")}`;
const valid = stored("2026-11-23T13:36:53.008002+08:00");

describe("the access token of the native CLI's stored sign-in", () => {
  it("is read from the keychain's encoded item, its hex print, and the profile's plain file alike", () => {
    expect(nativeAccessToken(inKeychain(valid), NOW)).toBe("native-access");
    expect(nativeAccessToken(`${Buffer.from(inKeychain(valid)).toString("hex")}\n`, NOW)).toBe("native-access");
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
    expect(nativeAccessToken(inKeychain("{}"), NOW)).toBeNull();
    expect(nativeAccessToken(JSON.stringify({ token: { access_token: "native-access" } }), NOW)).toBeNull();
    expect(nativeAccessToken(stored("2026-11-23T13:36:53Z", ""), NOW)).toBeNull();
  });
});

describe("where the native CLI's sign-in is read", () => {
  const env = { HOME: "/Users/person" };
  const profileFile = `${antigravityProfileDirectory("native")}/antigravity-acp/antigravity-oauth-token`;
  const store = (keychain: { item?: string; defaultKeychain: boolean } | null) => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const readText = vi.fn(async (path: string) => path === profileFile ? "profile-sign-in" : null);
    const value: NativeSignInStore = {
      security: keychain && (async (args, callEnv) => {
        calls.push({ args, env: callEnv });
        if (args[0] === "find-generic-password") return keychain.item === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: keychain.item };
        return { ok: keychain.defaultKeychain, stdout: "" };
      }),
      readText,
    };
    return { value, calls, readText };
  };

  it("is the keychain item the CLI keeps, asked with the CLI's own environment", async () => {
    const { value, calls, readText } = store({ item: "keychain-sign-in", defaultKeychain: true });
    expect(await readNativeSignIn("native", env, value)).toBe("keychain-sign-in");
    expect(calls).toEqual([{ args: ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], env }]);
    expect(readText).not.toHaveBeenCalled();
  });

  it("is none, not the profile's file, when the keychain the CLI uses holds no sign-in", async () => {
    const { value, readText } = store({ defaultKeychain: true });
    expect(await readNativeSignIn("native", env, value)).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  it("is the profile's file when the CLI's HOME has no keychain, or the machine none it uses", async () => {
    expect(await readNativeSignIn("native", env, store({ defaultKeychain: false }).value)).toBe("profile-sign-in");
    expect(await readNativeSignIn("native", env, store(null).value)).toBe("profile-sign-in");
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
    const readSignIn = vi.fn(async () => inKeychain(valid));
    const usage = await antigravityNativePlanUsage("native", { HOME: "/Users/person" }, deps, readSignIn);
    expect(usage).toMatchObject({ fiveHour: { available: true, usedPercent: 25 }, weekly: { available: true, usedPercent: 50 } });
    expect(readSignIn).toHaveBeenCalledWith("native", expect.objectContaining({ HOME: "/Users/person" }));
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/v1internal:retrieveUserQuotaSummary", "/v1internal:retrieveUserQuotaSummary"]);
    expect(requests.every((request) => request.authorization === "Bearer native-access" && request.body === "{}")).toBe(true);
    expect(JSON.stringify(usage)).not.toMatch(/native-access|native-refresh|person@example\.com/);
  });

  it("are no row, and ask Google nothing, without a live token or once the switch is off", async () => {
    const { requests, deps } = fixture();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => null)).toBeNull();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => stored("2026-11-23T04:00:00Z"))).toBeNull();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => { throw new Error("keychain"); })).toBeNull();
    expect(await antigravityNativePlanUsage("native", {}, deps, async () => valid, false)).toBeNull();
    expect(requests).toEqual([]);
  });
});
