import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { installFakeManagedCli, loginAt, nativeFixture, sessionAcceptedAt, type NativeFixture } from "../testing/antigravity-native-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { antigravityProfileDirectory, antigravityTokenPath } from "./antigravity-acp.ts";
import { AntigravityDriver } from "./antigravity.ts";

const WINDOWS = process.platform === "win32";
const LOGIN_NOTE = "Antigravity needs a Google account";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-native-"));
  scratch.push(directory);
  return directory;
}

/** A pinned runtime at a custom path: the ACP server with its harness beside it. */
function pinnedRuntime(name = "agy_acp_server"): string {
  const directory = folder();
  const executable = join(directory, name);
  const harness = join(directory, WINDOWS ? "localharness_external.exe" : "localharness_external");
  copyFileSync(FAKE_ACP, executable);
  copyFileSync(FAKE_ACP, harness);
  if (!WINDOWS) {
    chmodSync(executable, 0o755);
    chmodSync(harness, 0o755);
  }
  return executable;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  rmSync(join(antigravityRuntimesRoot(DATA_DIR), `${process.platform}-${process.arch}`), { recursive: true, force: true });
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

async function create(instanceId: string, fixture: NativeFixture, env: Record<string, string> = {}, cli: string = fixture.executable) {
  ensureDirs();
  const instance = await AntigravityDriver.create({
    instanceId, displayName: "Antigravity", enabled: true, config: { cli, fullAuto: false },
    environment: { FAKE_AGY_LOG: fixture.log, ...env },
  });
  instances.push(instance);
  return instance;
}

const credentials = (instanceId: string) => join(antigravityProfileDirectory(instanceId), "antigravity-acp", "antigravity-oauth-token");

async function turn(instance: ProviderInstance, threadId: string, cwd: string) {
  const recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hello", approvalMode: "ask", cwd });
  const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000);
  recorder.stop();
  return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
}

describe.skipIf(WINDOWS)("signing in to the native Antigravity CLI", () => {
  it("gets a link from the sign-in button and ends signed in, with a session started for the turn and no authenticate sent", async () => {
    const fixture = nativeFixture(folder());
    const instance = await create("antigravity-native-loop", fixture);

    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false, version: "1.5.14" });

    const started = await instance.startAuthentication!();
    expect(started).toMatchObject({ phase: "waiting", kind: "pasted-code" });
    expect(started.authorizationUrl).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/u);
    expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "waiting" });
    await instance.completeAuthentication!(started.flowId!, "fixture-code");
    expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "succeeded" });

    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    await instance.refreshModels!();
    expect(instance.models.options.map((option) => option.id)).toContain("fixture-account-model");
    expect(instance.modelsUnconfirmed).toBe(false);

    const { done } = await turn(instance, "native-loop", fixture.directory);
    expect(done).toMatchObject({ ok: true });
    expect(fixture.methods()).toContain("session/prompt");

    await instance.signOut!();
    expect(existsSync(credentials("antigravity-native-loop"))).toBe(false);
    expect(fixture.methods()).toContain("logout");
    expect(await instance.snapshot()).toMatchObject({ authenticated: false });
    const after = await turn(instance, "native-loop-again", fixture.directory);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining(LOGIN_NOTE), setup: true }));
    expect(after.done).toMatchObject({ ok: false, stopReason: "auth_required", unsent: true });

    expect(fixture.methods()).not.toContain("authenticate");
  }, 120_000);

  it("reads a CLI signed in through --login as signed in, and runs the turn", async () => {
    const fixture = nativeFixture(folder());
    const instanceId = "antigravity-native-terminal";
    const instance = await create(instanceId, fixture);
    expect(await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code")).toBe(0);
    expect(existsSync(credentials(instanceId))).toBe(true);
    // The CLI itself accepts a session: the sign-in is valid, whatever file MausBot looks at.
    expect(await sessionAcceptedAt(fixture, antigravityProfileDirectory(instanceId))).toBe(true);
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    const { done } = await turn(instance, "native-terminal", fixture.directory);
    expect(done).toMatchObject({ ok: true });
    expect(fixture.methods()).toContain("session/prompt");
    expect(fixture.methods()).not.toContain("authenticate");
  }, 120_000);

  it("forgets a signed-out answer when the instance is rebuilt, so a sign-in made meanwhile at a terminal is used at once", async () => {
    const fixture = nativeFixture(folder());
    const instanceId = "antigravity-native-rebuilt";
    const first = await create(instanceId, fixture);
    expect(await first.snapshot()).toMatchObject({ authenticated: false });
    await first.dispose();
    instances.splice(instances.indexOf(first), 1);
    await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
    const rebuilt = await create(instanceId, fixture);
    const { done } = await turn(rebuilt, "native-rebuilt", fixture.directory);
    expect(done).toMatchObject({ ok: true });
  }, 120_000);

  it("starts no process of its own to ask about the sign-in before a turn", async () => {
    const fixture = nativeFixture(folder());
    const instanceId = "antigravity-native-one-process";
    const instance = await create(instanceId, fixture);
    await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
    const before = fixture.methods().filter((method) => method === "initialize").length;
    const { done } = await turn(instance, "native-one-process", fixture.directory);
    expect(done).toMatchObject({ ok: true });
    expect(fixture.methods().filter((method) => method === "initialize").length - before).toBe(1);
  }, 120_000);

  it("sends no authenticate for model discovery, background text or a refused turn, and fails each as a sign-in request", async () => {
    const fixture = nativeFixture(folder());
    const instance = await create("antigravity-native-no-authenticate", fixture);
    await instance.refreshModels!();
    expect(instance.modelsUnconfirmed).toBe(true);
    expect(instance.modelsUnreadable).toBe("signedOut");
    await expect(instance.generateMemoryText!("hello")).rejects.toThrow(LOGIN_NOTE);
    const { done } = await turn(instance, "native-no-authenticate", fixture.directory);
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(fixture.methods()).not.toContain("authenticate");
    expect(fixture.methods()).toContain("session/new");
  }, 120_000);

  it("keeps a sign-in the CLI already held when the instance has never signed in here", async () => {
    const fixture = nativeFixture(folder());
    const instanceId = "antigravity-native-background";
    const instance = await create(instanceId, fixture);
    await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
    expect(await instance.generateMemoryText!("hello")).toBe("fixture reply");
    expect(fixture.methods()).not.toContain("authenticate");
  }, 120_000);

  it("reads a background session the CLI refuses as a sign-out, so the status stops saying signed in", async () => {
    const fixture = nativeFixture(folder());
    const instanceId = "antigravity-native-background-refused";
    const instance = await create(instanceId, fixture);
    await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    rmSync(credentials(instanceId), { force: true });
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    await expect(instance.generateMemoryText!("hello")).rejects.toThrow(LOGIN_NOTE);
    expect(await instance.snapshot()).toMatchObject({ authenticated: false });
  }, 120_000);

  describe("a CLI that cannot say", () => {
    it("is not read as signed out: the status leaves the answer out and a turn or check fails as an ordinary error", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-crash";
      const instance = await create(instanceId, fixture, { FAKE_AGY_HANG: "crash" });
      await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("available");
      expect("authenticated" in snapshot).toBe(false);
      const { done, events } = await turn(instance, "crash", fixture.directory);
      expect(done).toMatchObject({ ok: false });
      expect(done).not.toMatchObject({ stopReason: "auth_required" });
      expect(events.some((event) => event.type === "runtime.error" && (event as { setup?: boolean }).setup === true)).toBe(false);
      await expect(instance.generateMemoryText!("hello")).rejects.toThrow(/exited/u);
    }, 120_000);
  });

  describe("what was last read of the sign-in", () => {
    it("holds a signed-out answer for a while, and a check asks the CLI again at once", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-cache";
      const instance = await create(instanceId, fixture);
      expect(await instance.snapshot()).toMatchObject({ authenticated: false });
      const asked = () => fixture.methods().filter((method) => method === "session/new").length;
      const before = asked();
      await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      expect(await instance.snapshot()).toMatchObject({ authenticated: false });
      expect(asked()).toBe(before);
      instance.forgetAuthentication!();
      expect(await instance.snapshot()).toMatchObject({ authenticated: true });
      expect(await instance.generateMemoryText!("hello")).toBe("fixture reply");
    }, 120_000);

  });

  describe("signing out", () => {
    it("asks the CLI to log out and removes what it kept", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-sign-out";
      const instance = await create(instanceId, fixture);
      const started = await instance.startAuthentication!();
      await instance.completeAuthentication!(started.flowId!, "fixture-code");
      await instance.signOut!();
      expect(fixture.methods()).toContain("logout");
      expect(existsSync(credentials(instanceId))).toBe(false);
    }, 120_000);

    // The app starts the CLI as over SSH (antigravity-acp.ts), so each account keeps its own sign-in in its own profile.
    it("signs this account alone out: another account on the native CLI keeps its own sign-in", async () => {
      const fixture = nativeFixture(folder());
      const [one, two] = ["antigravity-native-file-one", "antigravity-native-file-two"];
      const first = await create(one, fixture);
      const second = await create(two, fixture);
      for (const instanceId of [one, two]) await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      expect(await second.snapshot()).toMatchObject({ authenticated: true });
      await first.signOut!();
      expect(existsSync(credentials(one))).toBe(false);
      expect(existsSync(credentials(two))).toBe(true);
      expect(await first.snapshot()).toMatchObject({ authenticated: false });
      expect(await second.snapshot()).toMatchObject({ authenticated: true });
    }, 120_000);

    it("signs out an account on agy that runs the native CLI", async () => {
      installFakeManagedCli(DATA_DIR);
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-agy-signs-out";
      const agy = await create(instanceId, fixture, {}, "agy");
      await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      await agy.signOut!();
      expect(fixture.methods()).toContain("logout");
      expect(existsSync(credentials(instanceId))).toBe(false);
    }, 120_000);

    it("leaves the pinned sign-in of an account that ran the native CLI and was moved back to the pinned runtime", async () => {
      const fixture = nativeFixture(folder());
      const [moved, native] = ["antigravity-native-moved-back", "antigravity-native-moved-other"];
      const before = await create(moved, fixture);
      await loginAt(fixture, antigravityProfileDirectory(moved), "fixture-code");
      expect((await turn(before, "moved-native", fixture.directory)).done).toMatchObject({ ok: true });
      await before.dispose();
      instances.splice(instances.indexOf(before), 1);
      await create(moved, fixture, {}, pinnedRuntime());
      const token = antigravityTokenPath(moved);
      mkdirSync(dirname(token), { recursive: true });
      writeFileSync(token, "{}", { mode: 0o600 });
      const signingOut = await create(native, fixture);
      await loginAt(fixture, antigravityProfileDirectory(native), "fixture-code");
      await signingOut.signOut!();
      expect(existsSync(token)).toBe(true);
    }, 120_000);

    it("leaves the sign-in of an account whose program is called antigravity but runs the pinned runtime beside its harness", async () => {
      const fixture = nativeFixture(folder());
      const [pinned, native] = ["antigravity-native-named-pinned", "antigravity-native-named-native"];
      await create(pinned, fixture, {}, pinnedRuntime("antigravity"));
      const token = antigravityTokenPath(pinned);
      mkdirSync(dirname(token), { recursive: true });
      writeFileSync(token, "{}", { mode: 0o600 });
      const signingOut = await create(native, fixture);
      await loginAt(fixture, antigravityProfileDirectory(native), "fixture-code");
      await signingOut.signOut!();
      expect(existsSync(token)).toBe(true);
    }, 120_000);

    it("leaves another account's sign-in in progress alone", async () => {
      installFakeManagedCli(DATA_DIR);
      const fixture = nativeFixture(folder());
      const signingIn = await create("antigravity-native-agy-login", fixture, {}, "agy");
      const started = await signingIn.startAuthentication!();
      expect(started).toMatchObject({ phase: "waiting", kind: "pasted-code" });
      const other = await create("antigravity-native-agy-other", fixture);
      await loginAt(fixture, antigravityProfileDirectory("antigravity-native-agy-other"), "fixture-code");
      await other.signOut!();
      expect(await signingIn.getAuthentication!(started.flowId!)).toMatchObject({ phase: "waiting" });
    }, 120_000);

    // 1.5.14 keeps one keyring entry per computer unless it runs over SSH; started as over SSH it never uses the keyring.
    it.each([["answers logout and keeps the sign-in", "ignore"], ["refuses logout", "refuse"]])("signs out, never touching the keyring, when the CLI %s", async (_name, logout) => {
      const fixture = nativeFixture(folder());
      const keyring = folder();
      const instanceId = `antigravity-native-keyring-${logout}`;
      const instance = await create(instanceId, fixture, { FAKE_AGY_KEYRING: keyring, FAKE_AGY_LOGOUT: logout });
      const started = await instance.startAuthentication!();
      await instance.completeAuthentication!(started.flowId!, "fixture-code");
      expect(existsSync(credentials(instanceId))).toBe(true);
      await instance.signOut!();
      expect(await instance.snapshot()).toMatchObject({ authenticated: false });
      expect(readdirSync(keyring)).toEqual([]);
    }, 120_000);

    it("fails, with the account kept, when the CLI cannot be asked to confirm", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-unconfirmed";
      const instance = await create(instanceId, fixture, { FAKE_AGY_HANG: "crash" });
      const started = await instance.startAuthentication!();
      await instance.completeAuthentication!(started.flowId!, "fixture-code");
      await expect(instance.signOut!()).rejects.toThrow("could not confirm the sign-out");
    }, 120_000);

    it("fails, rather than pass as done, when an account set to the native CLI cannot start it", async () => {
      const instance = await create("antigravity-native-missing-cli", nativeFixture(folder()), {}, "antigravity");
      await expect(instance.signOut!()).rejects.toThrow(/Antigravity CLI is not installed/u);
      const agy = await create("antigravity-native-agy-missing-cli", nativeFixture(folder()), { PATH: "/usr/bin:/bin" }, "agy");
      await expect(agy.signOut!()).rejects.toThrow();
      const moved = nativeFixture(folder());
      const custom = await create("antigravity-native-moved-cli", moved);
      renameSync(moved.executable, join(moved.directory, "moved-away"));
      await expect(custom.signOut!()).rejects.toThrow();
    }, 60_000);

    it("starts no native process of the account while its sign-in is being removed, so none reads the old sign-in", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-gated";
      const instance = await create(instanceId, fixture, { FAKE_AGY_LOGOUT_MS: "1500" });
      await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      const signingOut = instance.signOut!();
      await vi.waitFor(() => expect(fixture.entries().some((entry) => entry.event === "logout-start")).toBe(true), { timeout: 30_000 });
      instance.forgetAuthentication!();
      const during = instance.snapshot();
      await signingOut;
      expect(await during).toMatchObject({ authenticated: false });
    }, 60_000);

    it("signs an account on the pinned runtime out of both runtimes' sign-ins in its profile, without starting the CLI", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-pinned-signout";
      await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      const pinned = await create(instanceId, fixture, {}, pinnedRuntime());
      await pinned.signOut!();
      expect(fixture.methods()).not.toContain("logout");
      expect(existsSync(credentials(instanceId))).toBe(false);
    }, 120_000);

    it("does not ask for a sign-in when the CLI's sign-in service is down, in a turn or background text", async () => {
      const fixture = nativeFixture(folder());
      const instanceId = "antigravity-native-service-down";
      const instance = await create(instanceId, fixture, { FAKE_AGY_SESSION_ERROR: "Authentication service unavailable" });
      await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code");
      const { done, events } = await turn(instance, "native-service-down", fixture.directory);
      expect(done).toMatchObject({ ok: false });
      expect(done).not.toMatchObject({ stopReason: "auth_required" });
      expect(events.some((event) => event.type === "runtime.error" && (event as { setup?: boolean }).setup === true)).toBe(false);
      await expect(instance.generateMemoryText!("hello")).rejects.not.toThrow(LOGIN_NOTE);
    }, 120_000);
  });

  describe("which CLI an instance starts, with only the native CLI installed", () => {
    it.each(["antigravity", "agy"])("starts the native CLI for the path %s and says it runs it", async (cli) => {
      installFakeManagedCli(DATA_DIR);
      const asked = nativeFixture(folder());
      const native = await create(`antigravity-policy-${cli}`, asked, {}, cli);
      expect(await native.snapshot()).toMatchObject({ state: "available", version: "1.5.14", authenticated: false, nativeCli: true });
      expect(asked.methods()).toContain("initialize");
    }, 120_000);
  });

  describe("pasting into a sign-in", () => {
    it("refuses a second paste, one for another sign-in and one that is not a code, and ends on a wrong code", async () => {
      const fixture = nativeFixture(folder());
      const instance = await create("antigravity-native-paste", fixture);
      const started = await instance.startAuthentication!();
      await expect(instance.completeAuthentication!("another-flow", "fixture-code")).rejects.toThrow("no longer active");
      await expect(instance.completeAuthentication!(started.flowId!, "two\nlines")).rejects.toThrow("only the authorization code");
      await expect(instance.completeAuthentication!(started.flowId!, "https://example.test/oauth-callback?code=abc")).rejects.toThrow("not the page Google ends on");
      await expect(instance.completeAuthentication!(started.flowId!, "wrong-code")).rejects.toThrow("sign-in failed");
      expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "failed" });
    }, 120_000);

    it("accepts the callback page's full address, and a new sign-in replaces one that was never finished", async () => {
      const fixture = nativeFixture(folder());
      const instance = await create("antigravity-native-address", fixture);
      const first = await instance.startAuthentication!();
      const second = await instance.startAuthentication!();
      expect(second.flowId).not.toBe(first.flowId);
      expect(await instance.getAuthentication!(first.flowId!)).toMatchObject({ phase: "cancelled" });
      await expect(instance.completeAuthentication!(first.flowId!, "fixture-code")).rejects.toThrow("no longer active");
      await instance.completeAuthentication!(second.flowId!, "https://antigravity.google/oauth-callback?code=fixture-code&state=fixture-state");
      await expect(instance.completeAuthentication!(second.flowId!, "fixture-code")).rejects.toThrow("no longer active");
      expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    }, 120_000);

    it("is cancelled with its process gone", async () => {
      const fixture = nativeFixture(folder());
      const instance = await create("antigravity-native-cancel", fixture);
      const started = await instance.startAuthentication!();
      const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
      await instance.cancelAuthentication!();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "cancelled" });
    }, 120_000);
  });

  describe("signing out while a sign-in waits", () => {
    it("ends the sign-in's process before the CLI is asked to log out, through the sign-out the app offers", async () => {
      const fixture = nativeFixture(folder());
      const instance = await create("antigravity-native-waiting", fixture);
      const sessions = new ProviderAuthSessions();
      const started = await sessions.start(instance, "browser");
      expect(started).toMatchObject({ phase: "waiting", kind: "pasted-code" });
      const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
      await sessions.signOut(instance, "browser");
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fixture.entries().some((entry) => entry.event === "login-code")).toBe(false);
      // The sign-in ended; nobody was signed in, so there was nothing for the CLI to log out of.
      expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "cancelled" });
      expect(await instance.snapshot()).toMatchObject({ authenticated: false });
    }, 120_000);
  });

  describe("a sign-in that never gets as far as a link", () => {
    it.each([
      ["a link to another host", { FAKE_AGY_LOGIN: "bad-domain" }],
      ["a link that redirects elsewhere", { FAKE_AGY_LOGIN: "bad-redirect" }],
    ])("fails with a fixed line for %s", async (_name, env) => {
      const fixture = nativeFixture(folder());
      const instance = await create(`antigravity-native-${_name.replaceAll(" ", "-")}`, fixture, env);
      const failure = await instance.startAuthentication!().then(() => null, (error: Error) => error);
      expect(failure).not.toBeNull();
      expect(failure!.message).toMatch(/invalid Google sign-in link/u);
    }, 120_000);
  });
});
