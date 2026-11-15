import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as procs from "../procs.ts";
import {
  ANTIGRAVITY_AUTH_PREFIX,
  antigravityProfileAuthenticated,
  antigravitySessionSetup,
  antigravityTokenPath,
  linuxCaBundle,
  prepareAntigravityProfile,
  probeAntigravityModels,
  verifyAntigravityBrowserHelper,
} from "./antigravity-acp.ts";
import { AntigravityAuthController } from "./antigravity-auth.ts";
import { resolveAntigravityRuntime } from "./antigravity-runtime.ts";
import { AntigravityDriver } from "./antigravity.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");
const FAKE_SIGNIN = join(TESTING, "fake-antigravity-signin.ts");
const LINK = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2F";
const LOGIN_NOTE = "Antigravity needs a Google account — choose Sign in with Google in engine setup";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function fakeRuntime(source?: string) {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-sign-in-"));
  scratch.push(directory);
  const executable = join(directory, "fake-antigravity.ts");
  const harness = join(directory, process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
  if (source === undefined) copyFileSync(FAKE_ACP, executable);
  else writeFileSync(executable, source);
  copyFileSync(FAKE_ACP, harness);
  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
    chmodSync(harness, 0o755);
  }
  return { directory, executable };
}

/** Answers every request but `authenticate`, where it does `onAuthenticate` (JavaScript with `message` in scope). */
const runtimeSource = (onAuthenticate: string) => `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const reply = (id, body) => console.log(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }], agentCapabilities: {} } });
  else if (message.method === 'authenticate') { ${onAuthenticate} }
  else reply(message.id, { result: {} });
});
`;
const ASKS_FOR_SIGN_IN = `console.error(${JSON.stringify(ANTIGRAVITY_AUTH_PREFIX + LINK)});`;

function storeToken(instanceId: string): string {
  const token = antigravityTokenPath(instanceId);
  mkdirSync(dirname(token), { recursive: true });
  writeFileSync(token, "{}", { mode: 0o600 });
  return token;
}

async function create(instanceId: string, executable: string, environment: Record<string, string> = {}) {
  const instance = await AntigravityDriver.create({
    instanceId, displayName: "Antigravity", enabled: true,
    config: { cli: executable, fullAuto: false },
    environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", ...environment },
  });
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("a sign-in the runtime asks for in the middle of a turn", () => {
  it("fails the turn at once with the sign-in message and reports the account signed out until it signs in again", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const revoked = join(fake.directory, "revoked");
    writeFileSync(fake.executable, runtimeSource(`if (existsSync(${JSON.stringify(revoked)})) { ${ASKS_FOR_SIGN_IN} } else reply(message.id, { result: {} });`)
      .replace("import { createInterface }", "import { existsSync } from 'node:fs';\nimport { createInterface }"));
    const instanceId = "antigravity-revoked";
    const token = storeToken(instanceId);
    const instance = await create(instanceId, fake.executable);
    await instance.refreshModels?.().catch(() => {});
    expect((await instance.snapshot()).authenticated).toBe(true);
    writeFileSync(revoked, "");
    const recorder = recordEvents(instance.adapter);
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "revoked", text: "hello", cwd: fake.directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(Date.now() - started).toBeLessThan(30_000);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    expect(events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: LOGIN_NOTE, setup: true }));
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "auth_required" });
    expect((await instance.snapshot()).authenticated).toBe(false);

    const next = await instance.adapter.sendTurn({ threadId: "revoked", text: "again", cwd: fake.directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === next.turnId);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "auth_required" });

    writeFileSync(token, JSON.stringify({ fixture: "a new sign-in" }));
    utimesSync(token, new Date(), new Date(Date.now() + 5_000));
    expect((await instance.snapshot()).authenticated).toBe(true);
  }, 60_000);

  it("treats the protocol's sign-in-required error the same way", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-auth-required";
    storeToken(instanceId);
    const instance = await create(instanceId, fake.executable, { FAKE_ACP_MODE: "auth-required" });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "auth-required", text: "hello", cwd: fake.directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    expect(events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: LOGIN_NOTE, setup: true }));
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "auth_required" });
    expect((await instance.snapshot()).authenticated).toBe(false);
  }, 60_000);

  it("stops a model lookup the same way instead of waiting on a link nobody sees", async () => {
    const fake = fakeRuntime(runtimeSource(ASKS_FOR_SIGN_IN));
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "lookup", runtime, baseDir: fake.directory });
    writeFileSync(profile.tokenPath, "{}");
    await expect(probeAntigravityModels({ runtime, profile, fallbackDefault: "gemini" })).rejects.toThrow("asked for a new Google sign-in");
    expect(await antigravityProfileAuthenticated(profile)).toBe(false);
  }, 60_000);
});

describe("signing out of Antigravity", () => {
  it("stops the account's running runtime before it forgets the sign-in", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-pooled";
    const token = storeToken(instanceId);
    const children: ChildProcess[] = [];
    const spawn = procs.spawnCli;
    vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
      const child = spawn(...args);
      if (args[2]?.cwd === fake.directory) children.push(child);
      return child;
    });
    const instance = await create(instanceId, fake.executable, { FAKE_ACP_MODELS: "gemini-3.8-flash" });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "pooled", text: "hello", approvalMode: "full", cwd: fake.directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(children).toHaveLength(1);
    expect(children[0]!.exitCode).toBeNull();

    await instance.signOut!();
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
    expect(existsSync(token)).toBe(false);
    expect((await instance.snapshot()).authenticated).toBe(false);
  }, 90_000);
});

describe("the session setup for releases that write a workflow skill file", () => {
  it.each(["1.4.2", "1.4.3", "1.4.5", "agy_acp_server_1.4.3"])("turns run_workflow off on %s", (version) => {
    expect(antigravitySessionSetup({ agentInfo: { version } })).toEqual({ _meta: { antigravity: { disabledTools: ["run_workflow"] } } });
  });

  it.each(["1.4.1", "1.4.6", "1.4.20", "1.5.1", "1.1.1", "2.4.3", "", undefined, 143])("sends nothing on %s", (version) => {
    expect(antigravitySessionSetup({ agentInfo: { version } })).toEqual({});
  });

  it("rides the turn's session/new on the pinned release and not on another", async () => {
    ensureDirs();
    for (const [version, meta] of [["1.4.3", { antigravity: { disabledTools: ["run_workflow"] } }], ["1.1.1", undefined]] as const) {
      const fake = fakeRuntime();
      const dump = join(fake.directory, "dump.json");
      const instanceId = `antigravity-meta-${version}`;
      storeToken(instanceId);
      const instance = await create(instanceId, fake.executable, {
        FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_DUMP: dump, FAKE_ACP_AGENT_NAME: "Google Antigravity", FAKE_ACP_AGENT_VERSION: version,
      });
      const recorder = recordEvents(instance.adapter);
      const { turnId } = await instance.adapter.sendTurn({ threadId: `meta-${version}`, text: "hello", approvalMode: "full", cwd: fake.directory });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(JSON.parse(readFileSync(`${dump}.session.json`, "utf8"))._meta).toEqual(meta);
    }
  }, 90_000);
});

describe("the Google sign-in's state", () => {
  async function signIn(instanceId: string, source: string | Buffer) {
    const fake = fakeRuntime(String(source));
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseDir: fake.directory });
    const signedIn = vi.fn();
    const controller = new AntigravityAuthController(signedIn);
    return { controller, signedIn, profile, flow: await controller.start(runtime, profile) };
  }

  it("is waiting until the redirect is accepted, verifying after, and succeeded once Google finishes", async () => {
    const hold = runtimeSource(`${ASKS_FOR_SIGN_IN} process.stdin.on('data', () => {});`);
    const { controller, flow } = await signIn("state-waiting", hold);
    try {
      expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "waiting", flowId: flow.flowId, authorizationUrl: null });
      expect(await controller.get("another-flow")).toMatchObject({ phase: "expired", message: "Google sign-in expired. Start sign-in again." });
    } finally {
      controller.cancel();
    }
    expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "cancelled", message: "Google sign-in was cancelled." });

    const done = await signIn("state-done", readFileSync(FAKE_SIGNIN));
    const redirect = new URL(done.flow.authorizationUrl!).searchParams.get("redirect_uri")!;
    await done.controller.complete(done.flow.flowId!, `${redirect}?state=fixture&code=pasted`);
    expect(await done.controller.get(done.flow.flowId!)).toMatchObject({ phase: "succeeded" });
    expect(done.signedIn).toHaveBeenCalledOnce();
  }, 60_000);

  it("refuses a second redirect once one was accepted", async () => {
    const slow = String(readFileSync(FAKE_SIGNIN)).replace("if (pending !== null) reply(pending, {});", "setTimeout(() => reply(pending, {}), 1_500);");
    const { controller, flow, signedIn } = await signIn("state-twice", slow);
    try {
      const redirect = new URL(flow.authorizationUrl!).searchParams.get("redirect_uri")!;
      const first = controller.complete(flow.flowId!, `${redirect}?state=fixture&code=first`);
      await vi.waitFor(async () => expect((await controller.get(flow.flowId!)).phase).toBe("verifying"));
      await expect(controller.complete(flow.flowId!, `${redirect}?state=fixture&code=second`))
        .rejects.toThrow("The sign-in response was already sent. Wait for Google to finish.");
      await first;
      expect(signedIn).toHaveBeenCalledOnce();
    } finally {
      controller.cancel();
    }
  }, 60_000);

  it("lets a redirect that fails validation be corrected, and ends the sign-in when delivery fails", async () => {
    const { controller, flow } = await signIn("state-undelivered", runtimeSource(ASKS_FOR_SIGN_IN));
    try {
      await expect(controller.complete(flow.flowId!, "http://127.0.0.1:54321/?state=wrong&code=x")).rejects.toThrow("does not belong");
      expect((await controller.get(flow.flowId!)).phase).toBe("waiting");
      await expect(controller.complete(flow.flowId!, "http://127.0.0.1:54321/?state=fixture&code=x"))
        .rejects.toThrow("Could not deliver the sign-in response. Start sign-in again.");
      expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "failed", message: "Could not deliver the sign-in response. Start sign-in again." });
    } finally {
      controller.cancel();
    }
  }, 60_000);

  it.each([
    ["SUBSCRIPTION_REQUIRED: code 4/0Aprivate", "Google requires an eligible Antigravity subscription for this account."],
    ["access_denied", "Google sign-in was not approved. Start sign-in again."],
    ["boom code=4/0Aprivate", "Google sign-in failed. Start sign-in again."],
  ])("reports a failure as a fixed line, never the runtime's words (%s)", async (words, line) => {
    const fails = runtimeSource(`${ASKS_FOR_SIGN_IN} setTimeout(() => reply(message.id, { error: { code: -1, message: ${JSON.stringify(words)} } }), 200);`);
    const { controller, flow, signedIn } = await signIn("state-failed", fails);
    await vi.waitFor(async () => expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "failed", message: line }));
    expect(signedIn).not.toHaveBeenCalled();
  }, 60_000);

  it("expires after five minutes and says so", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { controller, flow } = await signIn("state-expired", runtimeSource(ASKS_FOR_SIGN_IN));
    try {
      expect(Date.parse(flow.expiresAt!) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      vi.useRealTimers();
      await vi.waitFor(async () => expect(await controller.get(flow.flowId!))
        .toMatchObject({ phase: "expired", message: "Google sign-in expired. Start sign-in again." }));
      await expect(controller.complete(flow.flowId!, "http://127.0.0.1:54321/?state=fixture&code=x")).rejects.toThrow("no longer active");
    } finally {
      vi.useRealTimers();
      controller.cancel();
    }
  }, 60_000);

  it("is readable through the status call by the browser that started it, as a callback-url sign-in", async () => {
    ensureDirs();
    const fake = fakeRuntime(runtimeSource(ASKS_FOR_SIGN_IN));
    const instance = await create("antigravity-status", fake.executable);
    expect(instance.authenticationMethod).toBe("callback-url");
    const sessions = new ProviderAuthSessions();
    const started = await sessions.start(instance, "browser-1");
    expect(await sessions.status(instance.instanceId, "browser-1", started.flowId!)).toMatchObject({ phase: "waiting" });
    await expect(sessions.status(instance.instanceId, "browser-2", started.flowId!)).rejects.toMatchObject({ status: 404 });
    await sessions.cancel(instance.instanceId, "browser-1", started.flowId!);
    expect(await sessions.status(instance.instanceId, "browser-1", started.flowId!)).toMatchObject({ phase: "cancelled" });
  }, 60_000);
});

describe("the runtime's launch environment", () => {
  it("drops an inherited crash-reporter pipe and, on Linux, names a certificate bundle that exists", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: "environment", runtime, baseDir: fake.directory, baseEnv: { PATH: process.env.PATH, CHROME_CRASHPAD_PIPE_NAME: "gone" },
    });
    expect(profile.environment.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined();
    const present = (path: string) => path === "/etc/ssl/certs/ca-certificates.crt" || path === "/nix/store/certs.crt";
    expect(linuxCaBundle({}, present)).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(linuxCaBundle({ NIX_SSL_CERT_FILE: "/nix/store/certs.crt" }, present)).toBe("/nix/store/certs.crt");
    expect(linuxCaBundle({ NIX_SSL_CERT_FILE: "relative/certs.crt" }, () => true)).toBe("/etc/ssl/certs/ca-bundle.crt");
    expect(linuxCaBundle({ SSL_CERT_FILE: "/own.crt" }, present)).toBeUndefined();
    expect(linuxCaBundle({ SSL_CERT_DIR: "/own" }, present)).toBeUndefined();
    expect(linuxCaBundle({}, () => false)).toBeUndefined();
  });

  it("checks that the browser helper hands the link over before a sign-in may start", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "helper", runtime, baseDir: fake.directory });
    await expect(verifyAntigravityBrowserHelper(profile)).resolves.toBeUndefined();
    const noisy = join(fake.directory, process.platform === "win32" ? "noisy.cmd" : "noisy");
    writeFileSync(noisy, process.platform === "win32" ? "@echo off\r\necho opened a browser\r\n" : "#!/bin/sh\necho opened a browser\n");
    if (process.platform !== "win32") chmodSync(noisy, 0o755);
    await expect(verifyAntigravityBrowserHelper(profile, noisy)).rejects.toThrow("Antigravity browser suppression could not be verified.");
  }, 60_000);
});
