import { describe, expect, it, vi } from "vitest";

import type { PlanFetch } from "../plan-usage.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { defaultNativeSignInStore, nativeAccessToken, readNativeAccessToken, type NativeSignInStore } from "./antigravity-native-sign-in.ts";
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

describe("which stored sign-in's access token is used", () => {
  const env = { HOME: "/Users/person" };
  const profileFile = `${antigravityProfileDirectory("native")}/antigravity-acp/antigravity-oauth-token`;
  const store = (keychain: string | null | undefined, file: string | null) => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const readText = vi.fn(async (path: string) => path === profileFile ? file : null);
    const value: NativeSignInStore = {
      security: keychain === undefined ? null : async (args, callEnv) => {
        calls.push({ args, env: callEnv });
        return keychain === null ? { ok: false, stdout: "" } : { ok: true, stdout: keychain };
      },
      readText,
    };
    return { value, calls, readText };
  };
  const live = (accessToken: string) => stored("2026-11-23T05:30:00Z", accessToken);
  const dead = (accessToken: string) => stored("2026-11-23T04:30:00Z", accessToken);

  it("is the keychain's while it is live, asked with the CLI's own environment, and the file is not read", async () => {
    const { value, calls, readText } = store(inKeychain(live("keychain-access")), live("file-access"));
    expect(await readNativeAccessToken("native", env, NOW, value)).toBe("keychain-access");
    expect(calls).toEqual([{ args: ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], env }]);
    expect(readText).not.toHaveBeenCalled();
  });

  it("is the profile file's when the keychain holds none or only an expired one, as after a failed keychain write", async () => {
    expect(await readNativeAccessToken("native", env, NOW, store(inKeychain(dead("keychain-access")), live("file-access")).value)).toBe("file-access");
    expect(await readNativeAccessToken("native", env, NOW, store(null, live("file-access")).value)).toBe("file-access");
  });

  it("is the profile file's alone under SSH, where the CLI keeps its sign-in there and not in the keychain", async () => {
    const { value, calls } = store(inKeychain(live("keychain-access")), live("file-access"));
    expect(await readNativeAccessToken("native", { ...env, SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }, NOW, value)).toBe("file-access");
    expect(calls).toEqual([]);
  });

  it("is none when every stored token has expired, so a file the CLI stopped writing soon shows nothing", async () => {
    expect(await readNativeAccessToken("native", env, NOW, store(inKeychain(dead("keychain-access")), dead("file-access")).value)).toBeNull();
    expect(await readNativeAccessToken("native", env, NOW, store(null, null).value)).toBeNull();
  });

  it("is the profile file's alone off macOS, where no keychain is asked", async () => {
    expect(defaultNativeSignInStore("linux").security).toBeNull();
    expect(defaultNativeSignInStore("win32").security).toBeNull();
    expect(await readNativeAccessToken("native", env, NOW, store(undefined, live("file-access")).value)).toBe("file-access");
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
