import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDeviceAuthController, codexDevicePrompt } from "./codex-device-auth.ts";

// Every subprocess uses this script and a disposable HOME. No real Codex
// process, provider network call, or user's credentials are involved.
const FAKE = `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const mode = process.env.FAKE_AUTH_MODE || 'success';
const args = process.argv.slice(2);
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({args, home, codexHome: process.env.CODEX_HOME, marker: process.env.INSTANCE_MARKER}) + '\\n');
if (args.join(' ') === 'login status') {
  if (mode === 'unconfirmed' && existsSync(join(home, 'authenticated'))) {
    // Account confirmation can exceed the assertion library's default 1s poll window.
    setTimeout(() => { process.stderr.write('Not logged in\\n'); process.exit(1); }, 1200);
  } else if (mode === 'status-hang') setInterval(() => {}, 1000);
  else if (mode === 'already' || (existsSync(join(home, 'authenticated')) && mode !== 'unconfirmed')) {
    process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0);
  } else if (mode === 'api') {
    process.stderr.write('Logged in using an API key - sk-private-token\\n'); process.exit(0);
  } else if (mode === 'unknown-status') {
    process.stderr.write('Unrecognized login status secret-token\\n'); process.exit(0);
  } else { process.stderr.write('Not logged in\\n'); process.exit(1); }
} else if (args.join(' ') === 'login --device-auth') {
  writeFileSync(join(home, 'pid'), String(process.pid));
  if (mode === 'old') { console.error("error: unexpected argument '--device-auth' found secret-token"); process.exit(2); }
  if (mode === 'disabled') { console.error('Device code authentication is not enabled secret-token'); process.exit(1); }
  if (mode === 'overflow') { console.error('secret-token'.repeat(4000)); setInterval(() => {}, 1000); }
  else {
    if (mode !== 'no-prompt') {
      console.error('Open this link:');
      console.error(mode === 'evil' ? 'https://evil.example/codex/device' : '\\x1b[36mhttps://auth.openai.com/codex/device\\x1b[0m');
      console.error('Enter this one-time code (expires in 15 minutes)');
      console.error('0CSG-0IXIM');
    }
    if (mode === 'success' || mode === 'unconfirmed') setTimeout(() => {
      writeFileSync(join(home, 'authenticated'), 'fake fixture only');
      console.error('Successfully logged in'); process.exit(0);
    }, 80);
    else if (mode === 'crash') setTimeout(() => { console.error('access_token=secret-token'); process.exit(1); }, 50);
    else { if (mode === 'ignore-term') process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  }
} else if (args.join(' ') === 'logout') {
  if (mode === 'logout-fails') { console.error('error: could not remove credentials secret-token'); process.exit(1); }
  if (mode === 'logout-hang' || mode === 'logout-ignore-term') {
    if (mode === 'logout-ignore-term') process.on('SIGTERM', () => {});
    writeFileSync(join(home, 'logout-pid'), String(process.pid));
    setInterval(() => {}, 1000);
  }
  else {
    const had = existsSync(join(home, 'authenticated'));
    if (mode !== 'logout-lies') try { unlinkSync(join(home, 'authenticated')); } catch {}
    console.error(had ? 'Successfully logged out' : 'Not logged in'); process.exit(0);
  }
} else process.exit(4);
`;

describe("Codex device prompt extraction", () => {
  it("extracts only complete, bounded code lines at the official device page", () => {
    const prompt = "  \u001b[36mhttps://auth.openai.com/codex/device\u001b[0m\n  0CSG-0IXIM\n";
    expect(codexDevicePrompt(prompt)).toEqual({ authorizationUrl: "https://auth.openai.com/codex/device", userCode: "0CSG-0IXIM" });
    expect(codexDevicePrompt(prompt.replace("0IXIM\n", "0IXI"))).toBeNull();
    for (const url of ["http://auth.openai.com/codex/device", "https://evil.example/codex/device", "https://auth.openai.com/codex/device?token=secret", "https://auth.openai.com/codex/device#token", "https://user@auth.openai.com/codex/device"]) {
      expect(codexDevicePrompt(`${url}\nABCD-EFGHI\n`)).toBeNull();
    }
    expect(codexDevicePrompt("https://auth.openai.com/codex/device\nsecret-token-value\n")).toBeNull();
  });
});

describe("Codex server-owned device authentication", () => {
  let home: string;
  let cli: string;
  let controllers: CodexDeviceAuthController[];
  const create = (mode = "success", overrides: Partial<ConstructorParameters<typeof CodexDeviceAuthController>[0]> = {}) => {
    const controller = new CodexDeviceAuthController({
      cli, environment: () => ({ ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), INSTANCE_MARKER: "own-instance", FAKE_AUTH_MODE: mode }),
      startupTimeoutMs: 1000, lifetimeMs: 3000, terminateTimeoutMs: 50,
      ...overrides,
    });
    controllers.push(controller);
    return controller;
  };
  const calls = () => readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-device-auth-"));
    cli = join(home, "fake-codex.mjs");
    writeFileSync(cli, FAKE, { mode: 0o700 });
    chmodSync(cli, 0o700);
    controllers = [];
  });
  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.dispose()));
    await removeTempDir(home);
  });

  it("returns the device code, confirms the actual login, and clears the code on completion", async () => {
    let refreshed = 0;
    const controller = create("success", { onAuthenticated: async () => { refreshed++; } });
    const start = await controller.start();
    expect(start).toMatchObject({ phase: "waiting", userCode: "0CSG-0IXIM", authorizationUrl: "https://auth.openai.com/codex/device" });
    expect(start.flowId).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(async () => (await controller.get(start.flowId!)).phase).toBe("succeeded");
    expect(await controller.get(start.flowId!)).toEqual({ phase: "succeeded", flowId: start.flowId, authorizationUrl: null, expiresAt: null });
    expect(refreshed).toBe(1);
    expect(calls().map((call) => call.args)).toEqual([["login", "status"], ["login", "--device-auth"], ["login", "status"]]);
    expect(calls().every((call) => call.home === home && call.codexHome === join(home, ".codex") && call.marker === "own-instance")).toBe(true);
    await expect(controller.get("another-user-flow")).rejects.toThrow("no longer available");
  });

  it("drives the reusable browser fixture only when its local approval marker is created", async () => {
    const controller = create("waiting", {
      cli: fileURLToPath(new URL("../testing/fake-codex-login-cli.ts", import.meta.url)),
      environment: () => ({ ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), OMB_DEVICE_AUTH_FIXTURE: "1" }),
    });
    const start = await controller.start();
    expect(start.userCode).toBe("TEST-12345");
    expect(existsSync(join(home, ".omb-fake-codex-authenticated"))).toBe(false);
    writeFileSync(join(home, ".omb-fake-codex-login-approved"), "approve fixture only\n");
    await expect.poll(async () => (await controller.get(start.flowId!)).phase).toBe("succeeded");
    expect(readFileSync(join(home, ".omb-fake-codex-authenticated"), "utf8")).toContain("not a credential");
  });

  describe("sign-out", () => {
    const signedIn = () => writeFileSync(join(home, "authenticated"), "fake fixture only");

    it("removes the stored sign-in, confirms it is gone, and frees the home for a new sign-in", async () => {
      signedIn();
      const controller = create("success");
      await controller.signOut();
      expect(existsSync(join(home, "authenticated"))).toBe(false);
      expect(calls().map((call) => call.args)).toEqual([["login", "status"], ["logout"], ["login", "status"]]);
      expect(calls().every((call) => call.home === home && call.codexHome === join(home, ".codex"))).toBe(true);
      const start = await controller.start();
      expect(start).toMatchObject({ phase: "waiting", userCode: "0CSG-0IXIM" });
    });

    it("refuses to pull a sign-in away while a browser is completing it", async () => {
      const controller = create("waiting");
      await controller.start();
      await expect(controller.signOut()).rejects.toThrow("sign-in in progress");
      // A sibling instance on the same credential home is refused as well.
      await expect(create("waiting").signOut()).rejects.toThrow("sign-in is running");
      expect(calls().map((call) => call.args)).not.toContainEqual(["logout"]);
      await controller.cancel();
    });

    it("reports a failed logout without repeating the CLI's output", async () => {
      signedIn();
      const failure = await create("logout-fails").signOut().catch((error: Error) => error.message);
      expect(failure).toContain("could not remove the sign-in");
      expect(failure).not.toContain("secret-token");
      expect(existsSync(join(home, "authenticated"))).toBe(true);
    });

    it("fails closed when Codex still reports a login after logout", async () => {
      signedIn();
      await expect(create("logout-lies").signOut()).rejects.toThrow("still reports a sign-in");
      expect(calls().map((call) => call.args)).toEqual([["login", "status"], ["logout"], ["login", "status"]]);
    });

    it("stops a hung logout and releases the credential home", async () => {
      signedIn();
      const controller = create("logout-hang", { startupTimeoutMs: 1000 });
      await expect(controller.signOut()).rejects.toThrow("could not remove the sign-in");
      // The lock is released: a later sign-out on the same home proceeds.
      await expect(create("success").signOut()).resolves.toBeUndefined();
    });

    it.skipIf(process.platform === "win32")("forcibly stops a logout that ignores graceful termination", async () => {
      signedIn();
      const controller = create("logout-ignore-term", { startupTimeoutMs: 1500 });
      let outcome = "pending";
      const pending = controller.signOut().then(() => { outcome = "succeeded"; }, () => { outcome = "failed"; });
      let pid: number | undefined;
      try {
        await expect.poll(() => existsSync(join(home, "logout-pid")), { timeout: 2500 }).toBe(true);
        pid = Number(readFileSync(join(home, "logout-pid"), "utf8"));
        await expect.poll(() => outcome, { timeout: 4000 }).toBe("failed");
        expect(alive(pid)).toBe(false);
        await expect(create("success").signOut()).resolves.toBeUndefined();
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(-pid, "SIGKILL");
        await pending;
      }
    });

    it("disposal stops an in-progress logout before returning", async () => {
      signedIn();
      const controller = create("logout-hang", { startupTimeoutMs: 10_000 });
      const pending = controller.signOut().catch(() => {});
      let pid: number | undefined;
      try {
        await expect.poll(() => existsSync(join(home, "logout-pid")), { timeout: 2500 }).toBe(true);
        pid = Number(readFileSync(join(home, "logout-pid"), "utf8"));
        await controller.dispose();
        expect(alive(pid)).toBe(false);
        await expect(create("success").signOut()).resolves.toBeUndefined();
      } finally {
        if (pid !== undefined && alive(pid)) {
          if (process.platform === "win32") process.kill(pid, "SIGKILL");
          else process.kill(-pid, "SIGKILL");
        }
        await pending;
      }
    });

    it("names a missing CLI and a removed provider plainly", async () => {
      await expect(create("success", { cli: join(home, "missing-codex") }).signOut()).rejects.toThrow("not installed on this server");
      const controller = create("success");
      await controller.dispose();
      await expect(controller.signOut()).rejects.toThrow("provider was removed");
    });

    it.each(["api", "unknown-status"])("preserves credentials when the current mode is %s", async (mode) => {
      await expect(create(mode).signOut()).rejects.toThrow("did not confirm a ChatGPT sign-in");
      expect(calls().map((call) => call.args)).toEqual([["login", "status"]]);
      expect(calls().map((call) => call.args)).not.toContainEqual(["logout"]);
    });

    it("does not mutate credentials when already signed out", async () => {
      await expect(create("success").signOut()).resolves.toBeUndefined();
      expect(calls().map((call) => call.args)).toEqual([["login", "status"]]);
    });
  });

  it("does not replace a working ChatGPT login", async () => {
    const start = await create("already").start();
    expect(start.phase).toBe("succeeded");
    expect(calls().map((call) => call.args)).toEqual([["login", "status"]]);
  });

  it("does not replace another auth method or expose its secret", async () => {
    await expect(create("api").start()).rejects.toThrow("different sign-in method");
    expect(calls()).toHaveLength(1);
  });

  it("fails closed when login status cannot establish the existing account", async () => {
    await expect(create("unknown-status").start()).rejects.toThrow("could not confirm the existing sign-in");
    expect(calls()).toHaveLength(1);
  });

  it("returns the same live code on an owner retry without spawning another login", async () => {
    const controller = create("waiting");
    const first = await controller.start();
    expect(await controller.start()).toEqual(first);
    expect(calls()).toHaveLength(2);
  });

  it("can cancel while the initial account check is still starting", async () => {
    const controller = create("status-hang");
    const starting = controller.start();
    const rejection = expect(starting).rejects.toThrow("cancelled");
    await expect.poll(() => existsSync(join(home, "calls.jsonl"))).toBe(true);
    await controller.cancel();
    await rejection;
    await expect(controller.start()).rejects.toThrow("did not provide");
  });

  it("does not start a process after the provider is disposed during startup", async () => {
    const controller = create();
    const starting = controller.start();
    const rejection = expect(starting).rejects.toThrow("provider was removed");
    await controller.dispose();
    await rejection;
    expect(existsSync(join(home, "calls.jsonl"))).toBe(false);
  });

  it.each([["old", "needs updating"], ["disabled", "Enable device-code login"], ["overflow", "unexpected sign-in response"]])("reports a safe, actionable %s failure", async (mode, message) => {
    const controller = create(mode);
    await expect(controller.start()).rejects.toThrow(message);
    await controller.cancel();
    expect(alive(Number(readFileSync(join(home, "pid"), "utf8")))).toBe(false);
  });

  it("fails safely when the configured executable is missing", async () => {
    await expect(create("success", { cli: join(home, "missing-codex") }).start()).rejects.toThrow("not installed on this server");
  });

  it.each(["evil", "no-prompt", "status-hang"])("bounds startup and reaps a %s process", async (mode) => {
    const controller = create(mode, { startupTimeoutMs: 250 });
    await expect(controller.start()).rejects.toThrow("did not provide a sign-in code in time");
    await controller.cancel();
    if (existsSync(join(home, "pid"))) expect(alive(Number(readFileSync(join(home, "pid"), "utf8")))).toBe(false);
  });

  it("requires a confirmed ChatGPT login even after an exit-0 device command", async () => {
    const controller = create("unconfirmed", { startupTimeoutMs: 3000, lifetimeMs: 8000 });
    const start = await controller.start();
    await expect.poll(async () => (await controller.get(start.flowId!)).phase, { timeout: 5000 }).toBe("failed");
    expect((await controller.get(start.flowId!)).message).toContain("did not confirm");
    expect(calls().map((call) => call.args)).toEqual([["login", "status"], ["login", "--device-auth"], ["login", "status"]]);
  });

  it("reports failure after a prompt without disclosing raw provider output", async () => {
    const controller = create("crash");
    const start = await controller.start();
    await expect.poll(async () => (await controller.get(start.flowId!)).phase).toBe("failed");
    expect(JSON.stringify(await controller.get(start.flowId!))).not.toContain("secret-token");
  });

  it("cancels and escalates shutdown for a CLI that ignores graceful termination", async () => {
    const controller = create("ignore-term");
    const start = await controller.start();
    const pid = Number(readFileSync(join(home, "pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    await controller.cancel();
    expect(alive(pid)).toBe(false);
    expect(await controller.get(start.flowId!)).toMatchObject({ phase: "cancelled", authorizationUrl: null });
    expect((await controller.get(start.flowId!)).userCode).toBeUndefined();
  });

  it("expires and reaps an unattended flow", async () => {
    // Long enough for two fake-CLI spawns on a loaded machine, short enough to expire promptly.
    const controller = create("waiting", { lifetimeMs: 1500 });
    const start = await controller.start();
    await expect.poll(async () => (await controller.get(start.flowId!)).phase, { timeout: 5000 }).toBe("expired");
    await controller.cancel();
    expect(alive(Number(readFileSync(join(home, "pid"), "utf8")))).toBe(false);
  });

  it("locks shared credentials across instances and releases only after cancellation", async () => {
    const one = create("waiting");
    const two = create("waiting");
    const first = await one.start();
    await expect(two.start()).rejects.toThrow("already running for this server account");
    await one.cancel();
    const second = await two.start();
    expect(second.flowId).not.toBe(first.flowId);
    await expect(two.get(first.flowId!)).rejects.toThrow("no longer available");
    await two.dispose();
    await expect(two.start()).rejects.toThrow("provider was removed");
  });
});
