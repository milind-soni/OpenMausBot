import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { nativeFixture, type NativeFixture } from "../testing/antigravity-native-fixture.ts";
import { prepareAntigravityProfile } from "./antigravity-acp.ts";
import {
  ANTIGRAVITY_LOGIN_REDIRECT,
  AntigravityCliLogin,
  antigravityLoginArgs,
  antigravityLoginInput,
  antigravityLoginLink,
} from "./antigravity-native-login.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

const WINDOWS = process.platform === "win32";
const LINK = `https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=${encodeURIComponent(ANTIGRAVITY_LOGIN_REDIRECT)}&response_type=code&scope=openid&state=s-1`;
const scratch: string[] = [];
const logins: AntigravityCliLogin[] = [];

class TrackedLogin extends AntigravityCliLogin {
  constructor(...args: ConstructorParameters<typeof AntigravityCliLogin>) {
    super(...args);
    logins.push(this);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const login of logins.splice(0)) await login.cancel();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("the sign-in link in the CLI's output", () => {
  it("is found by its shape, with the prompt lines around it in whatever words", () => {
    const output = `Open this link in a browser to log in with Google:\n\n  ${LINK}\nThen paste the authorization code, or the full URL, and press Enter:\n`;
    expect(antigravityLoginLink(output)).toEqual({ authorizationUrl: LINK, state: "s-1" });
    expect(antigravityLoginLink(`Sign in here -> ${LINK}\r\nthen paste what you get\r\n`)).toEqual({ authorizationUrl: LINK, state: "s-1" });
    expect(antigravityLoginLink(LINK.replace("&state=s-1", "") + "\n")).toEqual({ authorizationUrl: LINK.replace("&state=s-1", ""), state: null });
  });

  it("is not there until the line is whole", () => {
    expect(antigravityLoginLink("Open this link in a browser to log in with Google:\n")).toBeNull();
    expect(antigravityLoginLink(`  ${LINK.slice(0, 60)}`)).toBeNull();
    expect(antigravityLoginLink("")).toBeNull();
  });

  it.each([
    ["another host", LINK.replace("accounts.google.com", "accounts.example.test")],
    ["a host that only starts like Google's", LINK.replace("accounts.google.com", "accounts.google.com.example.test")],
    ["plain http", LINK.replace("https:", "http:")],
    ["another redirect", LINK.replace(encodeURIComponent(ANTIGRAVITY_LOGIN_REDIRECT), encodeURIComponent("http://127.0.0.1:9/"))],
    ["a second redirect", `${LINK}&redirect_uri=${encodeURIComponent("https://evil.example/")}`],
    ["a token response", LINK.replace("response_type=code", "response_type=token")],
    ["a path that is not an OAuth one", LINK.replace("/o/oauth2/auth", "/signin")],
    ["a fragment", `${LINK}#x`],
    ["user information", LINK.replace("https://", "https://user:pw@")],
    ["a link that is too long", `${LINK}&x=${"a".repeat(17_000)}`],
  ])("is refused for %s", (_name, link) => {
    expect(() => antigravityLoginLink(`${link}\n`)).toThrow("invalid Google sign-in link");
  });
});

describe("what a person pastes", () => {
  const pending = { state: "s-1" };

  it("is handed on as it is when it is an authorization code", () => {
    expect(antigravityLoginInput(pending, " 4/0AeaYSHB-x_y.z~1 \n")).toBe("4/0AeaYSHB-x_y.z~1");
    expect(antigravityLoginInput({ state: null }, "plain-code")).toBe("plain-code");
  });

  it("is handed on when it is the callback page's address with a code and this sign-in's state", () => {
    const page = `${ANTIGRAVITY_LOGIN_REDIRECT}?code=4%2F0Abc&state=s-1&scope=openid`;
    expect(antigravityLoginInput(pending, page)).toBe(page);
    expect(antigravityLoginInput(pending, `${ANTIGRAVITY_LOGIN_REDIRECT}?code=abc`)).toBe(`${ANTIGRAVITY_LOGIN_REDIRECT}?code=abc`);
    expect(antigravityLoginInput({ state: null }, `${ANTIGRAVITY_LOGIN_REDIRECT}?code=abc&state=anything`)).toContain("code=abc");
  });

  it.each([
    ["nothing", "  ", "Paste the authorization code"],
    ["two lines", "abc\ndef", "only the authorization code"],
    ["a code with spaces", "abc def", "does not look like an authorization code"],
    ["a code that is too long", "a".repeat(2_049), "does not look like an authorization code"],
    ["an address that is not the callback page", "https://example.test/oauth-callback?code=abc", "not the page Google ends on"],
    ["the callback page on another path", "https://antigravity.google/other?code=abc", "not the page Google ends on"],
    ["the callback page over http", "http://antigravity.google/oauth-callback?code=abc", "not the page Google ends on"],
    ["an address with no code", `${ANTIGRAVITY_LOGIN_REDIRECT}?state=s-1`, "no sign-in code"],
    ["an address with two codes", `${ANTIGRAVITY_LOGIN_REDIRECT}?code=a&code=b`, "no sign-in code"],
    ["an address Google ended with an error", `${ANTIGRAVITY_LOGIN_REDIRECT}?error=access_denied&state=s-1`, "was not approved"],
    ["an address of another sign-in", `${ANTIGRAVITY_LOGIN_REDIRECT}?code=abc&state=other`, "another sign-in"],
    ["an address that is not one", "https://", "full address"],
  ])("is refused as %s", (_name, pasted, line) => {
    expect(() => antigravityLoginInput(pending, pasted)).toThrow(line);
  });
});

describe("the sign-in's command", () => {
  it("is `acp --login` on the profile's folder and the app data folder the runtime uses", () => {
    expect(antigravityLoginArgs("/profile")).toEqual(["acp", "--login", "--gemini-dir", "/profile", "--app-data-dir", "antigravity-acp"]);
  });
});

describe.skipIf(WINDOWS)("a sign-in run by the CLI", () => {
  function setup(env: Record<string, string> = {}) {
    const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-login-"));
    scratch.push(directory);
    const fixture: NativeFixture = nativeFixture(join(directory, "cli"));
    const runtime: AntigravityRuntime = { executablePath: fixture.executable, harnessPath: null, source: "override", version: "1.5.14" };
    return { directory, fixture, runtime, env: { FAKE_AGY_LOG: fixture.log, ...env } };
  }
  async function profileOf(directory: string, runtime: AntigravityRuntime, env: Record<string, string>) {
    return prepareAntigravityProfile({ instanceId: `login-${directory}`, runtime, baseDir: directory, baseEnv: { ...process.env, ...env } });
  }

  it("waits for the code with the link in hand, and ends signed in when the CLI exits 0", async () => {
    const { directory, runtime, env, fixture } = setup();
    const hooks = { signedIn: vi.fn() };
    const login = new TrackedLogin(hooks);
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    expect(started).toMatchObject({ phase: "waiting", kind: "pasted-code" });
    expect(started.authorizationUrl).toContain("accounts.google.com");
    expect(await login.get(started.flowId!)).toMatchObject({ phase: "waiting" });
    await login.complete(started.flowId!, "fixture-code");
    expect(hooks.signedIn).toHaveBeenCalledTimes(1);
    expect(await login.get(started.flowId!)).toMatchObject({ phase: "succeeded" });
    expect(fixture.entries().find((entry) => entry.event === "login-code")).toMatchObject({ accepted: true, asAddress: false });
  }, 60_000);

  it("hands the CLI the page's address when that is what was pasted", async () => {
    const { directory, runtime, env, fixture } = setup();
    const login = new TrackedLogin({ signedIn: () => {} });
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    await login.complete(started.flowId!, `${ANTIGRAVITY_LOGIN_REDIRECT}?code=fixture-code&state=fixture-state`);
    expect(fixture.entries().find((entry) => entry.event === "login-code")).toMatchObject({ accepted: true, asAddress: true });
  }, 60_000);

  it("fails with one fixed line, never the CLI's own words, when the CLI refuses the code", async () => {
    const { directory, runtime, env } = setup();
    const hooks = { signedIn: vi.fn() };
    const login = new TrackedLogin(hooks);
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    const failure = await login.complete(started.flowId!, "secret-wrong-code").then(() => null, (error: Error) => error);
    expect(failure!.message).toBe("Google sign-in failed. Start sign-in again.");
    expect(JSON.stringify(await login.get(started.flowId!))).not.toContain("secret-wrong-code");
    expect(await login.get(started.flowId!)).toMatchObject({ phase: "failed", message: "Google sign-in failed. Start sign-in again." });
    expect(hooks.signedIn).not.toHaveBeenCalled();
    await expect(login.complete(started.flowId!, "fixture-code")).rejects.toThrow("no longer active");
  }, 60_000);

  it("takes a second paste of a code already sent as already sent, and does not write it twice", async () => {
    const { directory, runtime, env, fixture } = setup({ FAKE_AGY_LOGIN: "stay" });
    const login = new TrackedLogin({ signedIn: () => {} }, { submitMs: 400 });
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    const first = login.complete(started.flowId!, "fixture-code").catch((error: Error) => error);
    await vi.waitFor(async () => expect(await login.get(started.flowId!)).toMatchObject({ phase: "verifying" }));
    await expect(login.complete(started.flowId!, "fixture-code")).rejects.toThrow("already sent");
    await first;
    expect(fixture.entries().filter((entry) => entry.event === "login-code")).toHaveLength(1);
  }, 60_000);

  it("is signed in when the CLI stays up after taking the code and a session is then accepted", async () => {
    const { directory, runtime, env } = setup({ FAKE_AGY_LOGIN: "stay" });
    const hooks = { signedIn: vi.fn(), confirm: vi.fn(async () => true) };
    const login = new TrackedLogin(hooks, { submitMs: 400 });
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    await login.complete(started.flowId!, "fixture-code");
    expect(hooks.confirm).toHaveBeenCalledTimes(1);
    expect(hooks.signedIn).toHaveBeenCalledTimes(1);
    expect(await login.get(started.flowId!)).toMatchObject({ phase: "succeeded" });
    expect(login.active).toBe(false);
  }, 60_000);

  it("fails when the CLI stays up and no session is accepted", async () => {
    const { directory, runtime, env } = setup({ FAKE_AGY_LOGIN: "stay" });
    const hooks = { signedIn: vi.fn(), confirm: vi.fn(async () => false) };
    const login = new TrackedLogin(hooks, { submitMs: 400 });
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    await expect(login.complete(started.flowId!, "fixture-code")).rejects.toThrow("failed");
    expect(hooks.confirm).toHaveBeenCalledTimes(1);
    expect(hooks.signedIn).not.toHaveBeenCalled();
  }, 60_000);

  it("fails to start, with its process gone, when no link comes in time", async () => {
    const { directory, runtime, env, fixture } = setup({ FAKE_AGY_LOGIN: "no-link" });
    const login = new TrackedLogin({ signedIn: () => {} }, { startupMs: 3_000 });
    await expect(login.start(runtime, await profileOf(directory, runtime, env))).rejects.toThrow("did not return a link");
    const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }, 60_000);

  it("expires when the code is not pasted in time, and the CLI is stopped", async () => {
    const { directory, runtime, env, fixture } = setup({ FAKE_AGY_LOGIN: "hold" });
    const login = new TrackedLogin({ signedIn: () => {} }, { lifetimeMs: 300 });
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    await vi.waitFor(async () => expect(await login.get(started.flowId!)).toMatchObject({ phase: "expired", message: "Google sign-in expired. Start sign-in again." }));
    const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    await expect(login.complete(started.flowId!, "fixture-code")).rejects.toThrow("no longer active");
  }, 60_000);

  it("is cancelled with the CLI's process gone before cancel returns, and a cancel with nothing to cancel is done at once", async () => {
    const { directory, runtime, env, fixture } = setup({ FAKE_AGY_LOGIN: "hold" });
    const login = new TrackedLogin({ signedIn: () => {} });
    expect(await login.cancel()).toBe(true);
    const started = await login.start(runtime, await profileOf(directory, runtime, env));
    expect(await login.cancel()).toBe(true);
    const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await login.get(started.flowId!)).toMatchObject({ phase: "cancelled" });
  }, 60_000);

  it("keeps reporting a cancelled sign-in's process until it is gone, so a later sign-out cannot pass it by", async () => {
    const { directory, runtime, env, fixture } = setup({ FAKE_AGY_LOGIN: "hold" });
    const login = new TrackedLogin({ signedIn: () => {} }, { exitConfirmMs: 200 });
    await login.start(runtime, await profileOf(directory, runtime, env));
    const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
    const kill = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    try {
      expect(await login.cancel()).toBe(false);
      expect(await login.cancel()).toBe(false);
      await expect(login.start(runtime, await profileOf(directory, runtime, env))).rejects.toThrow("could not be stopped");
    } finally {
      kill.mockRestore();
    }
    expect(await login.cancel()).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);

  it("opens no flow for a start that a cancel overtook, and leaves no process of its own", async () => {
    const { directory, runtime, env } = setup({ FAKE_AGY_LOGIN: "hold" });
    const login = new TrackedLogin({ signedIn: () => {} });
    const starting = login.start(runtime, await profileOf(directory, runtime, env));
    await login.cancel();
    await expect(starting).rejects.toThrow("cancelled");
    expect(login.active).toBe(false);
    expect(await login.cancel()).toBe(true);
  }, 60_000);

  it("never reports another sign-in's id as its own", async () => {
    const { directory, runtime, env } = setup({ FAKE_AGY_LOGIN: "hold" });
    const login = new TrackedLogin({ signedIn: () => {} });
    const first = await login.start(runtime, await profileOf(directory, runtime, env));
    const second = await login.start(runtime, await profileOf(directory, runtime, env));
    expect(await login.get(first.flowId!)).toMatchObject({ phase: "cancelled" });
    expect(await login.get(second.flowId!)).toMatchObject({ phase: "waiting" });
    await expect(login.complete(first.flowId!, "fixture-code")).rejects.toThrow("no longer active");
    await login.cancel();
  }, 60_000);
});
