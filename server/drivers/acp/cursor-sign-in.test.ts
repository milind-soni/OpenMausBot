// Cursor on a server with no terminal (a Cloud): the CLI path must really run Cursor's CLI, and the sign-in runs where the
// bots run, from the app, with the link Cursor prints. Every process here is the offline fake in a disposable HOME.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceSignInHasCode, deviceSignInLink, deviceSignInPrompt, isDeviceSignInCode } from "../../../shared/device-sign-in.ts";
import { testCliBinary } from "../../cli-probe.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { DeviceAuthController } from "../device-auth.ts";
import { CURSOR_CLI_VERSION, CURSOR_SIGN_IN, CursorAgentDriver, readCursorStatus } from "./cursor.ts";

const FAKE_CURSOR = fileURLToPath(new URL("../../testing/fake-cursor-login-cli.ts", import.meta.url));
const LINK = "https://cursor.com/loginDeepControl?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true";
// cursor-agent 2026.10.22's own stdout for `login` with NO_OPEN_BROWSER.
const printed = (link: string) => ["Starting login process...", "Authenticating with Cursor...", "Waiting for browser authentication...", `Open a browser and navigate to this link: ${link}`, ""].join("\n");
// What curl 7.88.1 on the Cloud image prints for `curl https://cursor.com/install -fsS | bash --version`, which is what an
// install command pasted as the CLI path runs: curl's own --version wins over its other arguments.
const CURL = "curl 7.88.1 (x86_64-pc-linux-gnu) libcurl/7.88.1 OpenSSL/3.0.22 zlib/1.2.13 brotli/1.0.9 zstd/1.5.4\nRelease-Date: 2023-02-20, security patched: 7.88.1-10+deb12u15";

describe("which program answers as Cursor", () => {
  it("knows Cursor's own build number from curl's banner and other programs", () => {
    expect(CURSOR_CLI_VERSION.test("2026.10.22-27dcf5f")).toBe(true);
    expect(CURSOR_CLI_VERSION.test("2025.08.25-896bbe1\n")).toBe(true);
    for (const other of [CURL, "grok 1.0.41 (4220f3b224a6)", "2.1.284 (Claude Code)", "codex-cli 0.130.0", ""]) expect(CURSOR_CLI_VERSION.test(other), other).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Cursor's CLI path", () => {
  let home: string;
  const instances: ProviderInstance[] = [];
  beforeEach(() => {
    chmodSync(FAKE_CURSOR, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-cursor-path-"));
  });
  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
    await removeTempDir(home);
  });
  const cursor = async (cli: string, mode = "approve") => {
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor", displayName: "Cursor", enabled: true, config: CursorAgentDriver.decodeConfig({ cli }),
      environment: { HOME: home, USERPROFILE: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_CURSOR_MODE: mode },
    });
    instances.push(instance);
    return instance;
  };

  it("is unavailable, and says why, when the path runs another program that answers --version", async () => {
    // A script that prints curl's banner stands in for curl, which an install command pasted as the path runs.
    const pasted = join(home, "curl-banner.sh");
    writeFileSync(pasted, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(CURL)}\n`, { mode: 0o755 });
    const snapshot = await (await cursor(pasted)).snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot).not.toHaveProperty("version");
    expect(snapshot.reason).toContain("is not Cursor's CLI");
    expect(snapshot.reason).toContain("Reset");
  });

  it("is available, signed out until the sign-in, when the path runs Cursor's CLI", async () => {
    expect(await (await cursor(FAKE_CURSOR)).snapshot()).toEqual({ state: "available", version: "2026.10.22-27dcf5f", authenticated: false });
  });

  it("does not pass Settings' CLI test with another program's version", async () => {
    const pasted = join(home, "curl-banner.sh");
    writeFileSync(pasted, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(CURL)}\n`, { mode: 0o755 });
    const result = await testCliBinary(pasted, CursorAgentDriver);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("is not Cursor's CLI");
    const real = join(home, "cursor-agent");
    writeFileSync(real, "#!/bin/sh\necho 2026.10.22-27dcf5f\n", { mode: 0o755 });
    expect(await testCliBinary(real, CursorAgentDriver)).toEqual({ ok: true, version: "2026.10.22-27dcf5f" });
  });
});

describe("Cursor's sign-in link", () => {
  it("reads the one link Cursor prints, with no code to enter", () => {
    expect(deviceSignInHasCode("cursor")).toBe(false);
    expect(deviceSignInPrompt("cursor", printed(LINK))).toEqual({ authorizationUrl: LINK });
    expect(deviceSignInLink("cursor", LINK)).toBe(LINK);
    expect(isDeviceSignInCode("cursor", "QKXP-7M4D")).toBe(false);
  });

  it("waits for the link line to arrive whole", () => {
    expect(deviceSignInPrompt("cursor", printed(LINK).trimEnd())).toBeNull();
  });

  it.each([
    "http://cursor.com/loginDeepControl?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
    "https://cursor.com.evil.test/loginDeepControl?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
    "https://user@cursor.com/loginDeepControl?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
    "https://cursor.com/settings?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
    "https://cursor.com/loginDeepControl?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e&token=secret-token",
    "https://cursor.com/loginDeepControl?mode=login",
    "https://cursor.com/loginDeepControl?challenge=Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y&uuid=3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e#frag",
  ])("never turns another address into a sign-in link: %s", (link) => {
    expect(deviceSignInPrompt("cursor", printed(link))).toBeNull();
    expect(deviceSignInLink("cursor", link)).toBeNull();
  });

  it("reads Cursor's status answer", () => {
    expect(readCursorStatus(0, '{\n  "status": "unauthenticated",\n  "isAuthenticated": false\n}\n')).toBe("signed-out");
    expect(readCursorStatus(0, '{"status":"authenticated","isAuthenticated":true}')).toBe("signed-in");
    expect(readCursorStatus(1, '{"isAuthenticated":true}')).toBe("unknown");
    expect(readCursorStatus(0, "something else")).toBe("unknown");
  });
});

describe.skipIf(process.platform === "win32")("Cursor sign-in from the app, where the bots run", () => {
  let home: string;
  let instance: ProviderInstance;
  const calls = () => readFileSync(join(home, "fake-cursor-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const pid = () => Number(readFileSync(join(home, "fake-cursor-login.pid"), "utf8"));
  const alive = (target: number) => { try { process.kill(target, 0); return true; } catch { return false; } };
  beforeEach(async () => {
    chmodSync(FAKE_CURSOR, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-cursor-sign-in-"));
    instance = await CursorAgentDriver.create({
      instanceId: "cursor", displayName: "Cursor", enabled: true, config: CursorAgentDriver.decodeConfig({ cli: FAKE_CURSOR }),
      environment: { HOME: home, USERPROFILE: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_CURSOR_MODE: "approve" },
    });
  });
  afterEach(async () => {
    await instance.dispose();
    await removeTempDir(home);
  });

  it("offers it as a sign-in from the app, with no terminal", () => {
    expect(instance.startAuthentication).toBeTypeOf("function");
    expect(instance.getAuthentication).toBeTypeOf("function");
    expect(instance.completeAuthentication).toBeUndefined();
  });

  it("shows Cursor's link, then confirms the sign-in the driver's own check reads once the person finishes it", async () => {
    expect((await instance.snapshot()).authenticated).toBe(false);
    const start = await instance.startAuthentication!();
    expect(start).toEqual({ phase: "waiting", flowId: expect.stringMatching(/^[0-9a-f-]{36}$/), authorizationUrl: LINK, expiresAt: expect.any(String) });
    // The login never tries to open a browser on the server.
    expect(calls().find((call) => call.args[0] === "login")).toEqual({ args: ["login"], noOpenBrowser: "1" });
    expect(await instance.getAuthentication!(start.flowId!)).toMatchObject({ phase: "waiting", authorizationUrl: LINK });
    writeFileSync(join(home, ".omb-fake-cursor-approved"), "");
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(existsSync(join(home, ".config", "cursor", "auth.json"))).toBe(true);
    expect((await instance.snapshot()).authenticated).toBe(true);
  });

  it("cancels: the login stops and the link is gone", async () => {
    const start = await instance.startAuthentication!();
    expect(alive(pid())).toBe(true);
    await instance.cancelAuthentication!();
    expect(alive(pid())).toBe(false);
    expect(await instance.getAuthentication!(start.flowId!)).toMatchObject({ phase: "cancelled", authorizationUrl: null });
  });

  it.each([["evil"], ["extra"]])("shows no link from a %s address, and gives up waiting for one", async (mode) => {
    const controller = new DeviceAuthController(CURSOR_SIGN_IN, {
      cli: FAKE_CURSOR, startupTimeoutMs: 1_000, terminateTimeoutMs: 50,
      environment: () => ({ ...process.env, HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_CURSOR_MODE: mode }),
    });
    try {
      await expect(controller.start()).rejects.toThrow("Cursor did not provide a sign-in code in time");
      await controller.cancel();
      expect(alive(pid())).toBe(false);
    } finally { await controller.dispose(); }
  });

  it("never repeats the CLI's own words when the login fails", async () => {
    const controller = new DeviceAuthController(CURSOR_SIGN_IN, {
      cli: FAKE_CURSOR, startupTimeoutMs: 2_000, terminateTimeoutMs: 50,
      environment: () => ({ ...process.env, HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_CURSOR_MODE: "crash" }),
    });
    try {
      const start = await controller.start();
      await expect.poll(async () => (await controller.get(start.flowId!)).phase, { timeout: 5_000 }).toBe("failed");
      const status = await controller.get(start.flowId!);
      expect(status.message).toBe("Cursor sign-in did not finish. Check the server's connection, then try again.");
      expect(JSON.stringify(status)).not.toContain("secret-token");
    } finally { await controller.dispose(); }
  });
});
