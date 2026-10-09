// Grok Build signs in from the app with a one-time code: `grok login
// --device-auth`, run by the same instance, binary and environment its turns
// use, through the one device-code controller Codex uses too. Every process
// here is the offline fake grok in a disposable HOME: no real Grok, no call
// to xAI, nobody's credentials.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceSignInLink, deviceSignInPrompt, isDeviceSignInCode } from "../../../shared/device-sign-in.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { DeviceAuthController } from "../device-auth.ts";
import { GROK_DEVICE_SIGN_IN, GrokAgentDriver } from "./grok.ts";

const FAKE_GROK = fileURLToPath(new URL("../../testing/fake-grok-login-cli.ts", import.meta.url));
const PAGE = "https://accounts.x.ai/device";
const CODE = "WDJB-MJHT";

describe("Grok device prompt", () => {
  // What the server reads: grok's own lines, with its terminal styling removed.
  const printed = (page: string, code = CODE) => stripVTControlCharacters(
    `\nTo sign in, open this URL in your browser:\n    \u001b[1m${page}\u001b[0m\n\nThen enter this code:\n    ${code}\nWaiting for authorization...\n`);

  it("reads xAI's page and the code from whole lines only", () => {
    expect(deviceSignInPrompt("grok", printed(PAGE))).toEqual({ authorizationUrl: PAGE, userCode: CODE });
    expect(deviceSignInPrompt("grok", printed("https://auth.x.ai/device"))).toEqual({ authorizationUrl: "https://auth.x.ai/device", userCode: CODE });
    // a code still arriving is not a code yet
    expect(deviceSignInPrompt("grok", `${PAGE}\nWDJB-MJ`)).toBeNull();
    expect(deviceSignInPrompt("grok", `${PAGE}\n${CODE}\n`)).toEqual({ authorizationUrl: PAGE, userCode: CODE });
  });

  it("accepts the page that carries the code itself, only with that same code", () => {
    const complete = `${PAGE}?user_code=${CODE}`;
    expect(deviceSignInPrompt("grok", printed(complete))).toEqual({ authorizationUrl: complete, userCode: CODE });
    expect(deviceSignInPrompt("grok", printed(`${PAGE}?user_code=ZZZZ-ZZZZ`))).toBeNull();
  });

  it.each([
    "http://accounts.x.ai/device",
    "https://x.ai.evil.test/device",
    "https://evilx.ai/device",
    "https://user@accounts.x.ai/device",
    "https://accounts.x.ai:8443/device",
    "https://accounts.x.ai/device#token",
    "https://accounts.x.ai/device?token=secret-token",
    "https://auth.openai.com/codex/device",
  ])("never turns another page into a sign-in link: %s", (page) => {
    expect(deviceSignInPrompt("grok", printed(page))).toBeNull();
    expect(deviceSignInLink("grok", page, CODE)).toBeNull();
  });

  it("knows a code from other output", () => {
    expect(isDeviceSignInCode("grok", CODE)).toBe(true);
    for (const line of ["Waiting for authorization...", "secret-token", "wdjb-mjht", "AB", ""]) expect(isDeviceSignInCode("grok", line)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Grok Build sign-in with a device code", () => {
  let home: string;
  let instances: ProviderInstance[];
  const grok = async (mode: string, environment: Record<string, string> = {}) => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok", displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli: FAKE_GROK }),
      // A stray xAI key must not reach the subscription login (transformEnv).
      environment: { HOME: home, USERPROFILE: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_GROK_MODE: mode, XAI_API_KEY: "xai-fixture-must-not-leak", ...environment },
    });
    instances.push(instance);
    return instance;
  };
  const calls = () => readFileSync(join(home, "fake-grok-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const pid = () => Number(readFileSync(join(home, "fake-grok-login.pid"), "utf8"));
  const alive = (target: number) => { try { process.kill(target, 0); return true; } catch { return false; } };

  beforeEach(() => {
    chmodSync(FAKE_GROK, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-grok-device-"));
    instances = [];
  });
  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.dispose()));
    await removeTempDir(home);
  });

  it("shows xAI's page and code, then confirms the sign-in the driver's own check reads", async () => {
    const instance = await grok("success");
    expect((await instance.snapshot()).authenticated).toBe(false);
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ phase: "waiting", authorizationUrl: PAGE, userCode: CODE, flowId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await expect.poll(() => instance.getAuthentication!(start.flowId!), { timeout: 5_000 })
      .toEqual({ phase: "succeeded", flowId: start.flowId, authorizationUrl: null, expiresAt: null });
    expect(existsSync(join(home, ".grok", "auth.json"))).toBe(true);
    expect((await instance.snapshot()).authenticated).toBe(true);
    // One login, run as the turns run: this HOME, no API key riding along.
    const logins = calls().filter((call) => call.args[0] === "login");
    expect(logins).toEqual([{ args: ["login", "--device-auth"], home, grokHome: join(home, ".grok"), xaiKey: null }]);
  });

  it("signs in to the instance's own GROK_HOME, and reads it there", async () => {
    const grokHome = join(home, "work-grok");
    const instance = await grok("complete", { GROK_HOME: grokHome });
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ authorizationUrl: `${PAGE}?user_code=${CODE}`, userCode: CODE });
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(existsSync(join(grokHome, "auth.json"))).toBe(true);
    expect(existsSync(join(home, ".grok", "auth.json"))).toBe(false);
    expect((await instance.snapshot()).authenticated).toBe(true);
  });

  it("signs in again over a stored login instead of trusting it", async () => {
    // A stored login can be the stale one a failed turn just refused.
    mkdirSync(join(home, ".grok"));
    writeFileSync(join(home, ".grok", "auth.json"), "{}");
    const instance = await grok("waiting");
    expect((await instance.snapshot()).authenticated).toBe(true);
    expect(await instance.startAuthentication!()).toMatchObject({ phase: "waiting", userCode: CODE });
    await instance.cancelAuthentication!();
  });

  it("cancels: the login process stops and the code is gone", async () => {
    const instance = await grok("ignore-term");
    const start = await instance.startAuthentication!();
    expect(alive(pid())).toBe(true);
    await instance.cancelAuthentication!();
    expect(alive(pid())).toBe(false);
    const status = await instance.getAuthentication!(start.flowId!);
    expect(status).toMatchObject({ phase: "cancelled", message: "Grok sign-in cancelled.", authorizationUrl: null });
    expect(status.userCode).toBeUndefined();
    expect(existsSync(join(home, ".grok", "auth.json"))).toBe(false);
  });

  it("times out an unattended code and stops its process", async () => {
    // An instance's code lives fifteen minutes; the same controller with a
    // short lifetime shows what happens when nobody finishes.
    const controller = new DeviceAuthController(GROK_DEVICE_SIGN_IN, {
      cli: FAKE_GROK, lifetimeMs: 1_500, terminateTimeoutMs: 50,
      environment: () => ({ ...process.env, HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_GROK_MODE: "waiting" }),
    });
    try {
      const start = await controller.start();
      await expect.poll(async () => (await controller.get(start.flowId!)).phase, { timeout: 5_000 }).toBe("expired");
      expect((await controller.get(start.flowId!)).message).toBe("The Grok sign-in code expired. Start sign-in again.");
      await controller.cancel();
      expect(alive(pid())).toBe(false);
    } finally { await controller.dispose(); }
  });

  it("does not show a page on another host, and gives up waiting for one", async () => {
    const controller = new DeviceAuthController(GROK_DEVICE_SIGN_IN, {
      cli: FAKE_GROK, startupTimeoutMs: 1_000, terminateTimeoutMs: 50,
      environment: () => ({ ...process.env, HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_GROK_MODE: "evil" }),
    });
    try {
      await expect(controller.start()).rejects.toThrow("Grok did not provide a sign-in code in time");
      await controller.cancel();
      expect(alive(pid())).toBe(false);
    } finally { await controller.dispose(); }
  });

  it.each([
    ["expired", "The Grok sign-in code expired. Start sign-in again for a new code."],
    ["denied", "Grok sign-in was declined in the browser. Start sign-in again to try once more."],
    ["crash", "Grok sign-in did not finish. Check the server's connection, then try again."],
    ["no-credential", "Grok finished sign-in but did not confirm a Grok account. Refresh Settings and try again."],
  ])("ends a %s sign-in with one plain message and none of the CLI's words", async (mode, message) => {
    const instance = await grok(mode);
    const start = await instance.startAuthentication!();
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("failed");
    const status = await instance.getAuthentication!(start.flowId!);
    expect(status.message).toBe(message);
    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect((await instance.snapshot()).authenticated).toBe(false);
  });

  it("says plainly when the server's Grok is too old for a code, or missing", async () => {
    await expect((await grok("old")).startAuthentication!()).rejects.toThrow("This server's Grok is too old to sign in with a code. Update Grok on the server, then try again.");
    const missing = await GrokAgentDriver.create({
      instanceId: "grok-missing", displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli: join(home, "no-such-grok") }),
      environment: { HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1" },
    });
    instances.push(missing);
    await expect(missing.startAuthentication!()).rejects.toThrow("Grok is not installed on this server.");
  });

  it("returns the same live code on a second click, and one sign-in per Grok home", async () => {
    const one = await grok("waiting");
    const first = await one.startAuthentication!();
    expect(await one.startAuthentication!()).toEqual(first);
    const sibling = await grok("waiting");
    await expect(sibling.startAuthentication!()).rejects.toThrow("A Grok sign-in is already running for this server account.");
    await one.cancelAuthentication!();
    const second = await sibling.startAuthentication!();
    expect(second.flowId).not.toBe(first.flowId);
    await sibling.cancelAuthentication!();
  });

  it("stops a sign-in in progress when the instance goes away", async () => {
    const instance = await grok("waiting");
    await instance.startAuthentication!();
    const running = pid();
    await instance.dispose();
    expect(alive(running)).toBe(false);
  });

  it("approves through the reusable fixture only once its local marker exists", async () => {
    const instance = await grok("approve");
    const start = await instance.startAuthentication!();
    expect((await instance.getAuthentication!(start.flowId!)).phase).toBe("waiting");
    writeFileSync(join(home, ".omb-fake-grok-approved"), "approve fixture only\n");
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
  });
});
