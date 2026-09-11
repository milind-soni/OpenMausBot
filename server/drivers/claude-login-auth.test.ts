import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeLoginController, claudeLoginCode, claudeLoginPrompt, claudeSignInLink } from "./claude-login-auth.ts";

// A stand-in for the Claude CLI: prints what `claude auth login` prints,
// waits for the pasted code on stdin, and answers `auth status --json`. It
// never touches the network or any real credential.
const FAKE = `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const mode = process.env.FAKE_AUTH_MODE || 'success';
const args = process.argv.slice(2);
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ args, home, configDir: process.env.CLAUDE_CONFIG_DIR, browser: process.env.BROWSER }) + '\\n');
if (args.join(' ') === 'auth status --json') {
  if (mode === 'status-broken') { process.stdout.write('not json\\n'); process.exit(0); }
  if (mode === 'status-error-out') { process.stdout.write(JSON.stringify({ loggedIn: false }) + '\\n'); process.exit(2); }
  const signedIn = mode === 'already' || existsSync(join(home, 'authenticated'));
  process.stdout.write(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : undefined }) + '\\n');
  process.exit(signedIn ? 0 : 1);
} else if (args.join(' ') === 'auth login') {
  writeFileSync(join(home, 'pid'), String(process.pid));
  if (mode === 'no-url') { setInterval(() => {}, 1000); }
  else {
    process.stdout.write('Opening browser to sign in…\\n');
    const link = mode === 'evil' ? 'https://evil.example/oauth/authorize?code=true' : 'https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=abc';
    process.stdout.write('If the browser didn\\'t open, visit: ' + link + '\\n');
    process.stdout.write('Paste code here if prompted > ');
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\\n')) return;
      const code = buffered.split('\\n')[0].trim();
      if (code === 'GOODCODE#abc') {
        writeFileSync(join(home, 'authenticated'), 'fixture only');
        process.stdout.write('Login successful\\n');
        process.exit(0);
      }
      process.stderr.write('Invalid authorization code\\n');
      process.exit(1);
    });
  }
} else if (args.join(' ') === 'auth logout') {
  if (mode === 'logout-hang' || mode === 'logout-ignore-term') {
    if (mode === 'logout-ignore-term') process.on('SIGTERM', () => {});
    writeFileSync(join(home, 'logout-pid'), String(process.pid));
    setInterval(() => {}, 1000);
  }
  else {
    if (mode !== 'logout-lies') { try { unlinkSync(join(home, 'authenticated')); } catch {} }
    process.stdout.write('Logged out\\n');
    process.exit(0);
  }
} else {
  process.stderr.write('unsupported fixture command\\n');
  process.exit(2);
}
`;

describe("the sign-in link and code checks", () => {
  it("accepts only Anthropic's own https pages and complete lines", () => {
    expect(claudeSignInLink("https://claude.com/cai/oauth/authorize?code=true&state=x")).toContain("claude.com");
    expect(claudeSignInLink("https://platform.claude.com/oauth/code/callback")).toBeTruthy();
    expect(claudeSignInLink("https://console.anthropic.com/oauth/authorize")).toBeTruthy();
    expect(claudeSignInLink("http://claude.com/x")).toBeNull();
    expect(claudeSignInLink("https://evil.example/claude.com")).toBeNull();
    expect(claudeSignInLink("https://claude.com.evil.example/x")).toBeNull();
    expect(claudeSignInLink("https://user:pw@claude.com/x")).toBeNull();
    expect(claudeLoginPrompt("Opening browser…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true")).toBeNull();
    expect(claudeLoginPrompt("Opening browser…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code")).toEqual({ authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true" });
    expect(claudeLoginPrompt("visit: https://evil.example/x\n")).toBeNull();
    expect(claudeLoginCode("  GOODCODE#abc ")).toBe("GOODCODE#abc");
    expect(claudeLoginCode("short")).toBeNull();
    expect(claudeLoginCode("has spaces in it here")).toBeNull();
  });
});

describe("Claude server-owned sign-in", () => {
  let home: string;
  let cli: string;
  let controllers: ClaudeLoginController[];
  const create = (mode = "success", overrides: Partial<ConstructorParameters<typeof ClaudeLoginController>[0]> = {}) => {
    const controller = new ClaudeLoginController({
      cli,
      environment: () => ({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), FAKE_AUTH_MODE: mode }),
      startupTimeoutMs: 1000,
      lifetimeMs: 3000,
      completeTimeoutMs: 3000,
      terminateTimeoutMs: 50,
      ...overrides,
    });
    controllers.push(controller);
    return controller;
  };
  const calls = () => readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-claude-login-"));
    cli = join(home, "fake-claude.mjs");
    writeFileSync(cli, FAKE, { mode: 0o700 });
    chmodSync(cli, 0o700);
    controllers = [];
  });
  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.dispose()));
    await removeTempDir(home);
  });

  it("shows the link, takes the pasted code once, and confirms the login with the status command", async () => {
    let refreshed = 0;
    const controller = create("success", { onAuthenticated: async () => { refreshed++; } });
    const start = await controller.start();
    expect(start).toMatchObject({ phase: "waiting", authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=abc" });
    expect(start.userCode).toBeUndefined();
    expect(start.flowId).toMatch(/^[0-9a-f-]{36}$/);
    // a second click while waiting returns the same link, no second process
    expect((await controller.start()).flowId).toBe(start.flowId);
    await controller.complete(start.flowId!, " GOODCODE#abc\n");
    expect(await controller.get(start.flowId!)).toEqual({ phase: "succeeded", flowId: start.flowId, authorizationUrl: null, expiresAt: null });
    expect(refreshed).toBe(1);
    expect(calls().map((call) => call.args)).toEqual([["auth", "status", "--json"], ["auth", "login"], ["auth", "status", "--json"]]);
    expect(calls().every((call) => call.home === home && call.configDir === join(home, ".claude"))).toBe(true);
    expect(calls()[1].browser).toBe(process.platform === "win32" ? undefined : "true");
    await expect(controller.complete(start.flowId!, "GOODCODE#abc")).rejects.toThrow(/no longer available/);
  });

  it("reports a rejected code without keeping the process, and refuses malformed codes before sending", async () => {
    const controller = create();
    const start = await controller.start();
    await expect(controller.complete(start.flowId!, "bad")).rejects.toThrow(/whole code/);
    await expect(controller.complete(start.flowId!, "WRONGCODE#abc")).rejects.toThrow(/did not accept that code/);
    expect(await controller.get(start.flowId!)).toMatchObject({ phase: "failed" });
    const pid = Number(readFileSync(join(home, "pid"), "utf8"));
    await expect.poll(() => alive(pid)).toBe(false);
  });

  describe("sign-out", () => {
    const signedIn = () => writeFileSync(join(home, "authenticated"), "fixture only");

    it("removes the stored sign-in for this account's directory, confirms it, and allows a new sign-in", async () => {
      signedIn();
      const controller = create("success");
      await controller.signOut();
      expect(existsSync(join(home, "authenticated"))).toBe(false);
      expect(calls().map((call) => call.args)).toEqual([["auth", "logout"], ["auth", "status", "--json"]]);
      expect(calls().every((call) => call.configDir === join(home, ".claude"))).toBe(true);
      const start = await controller.start();
      expect(start).toMatchObject({ phase: "waiting", authorizationUrl: expect.stringContaining("https://claude.com/") });
    });

    it("refuses to pull a sign-in away while a browser is completing it", async () => {
      const controller = create("no-url", { startupTimeoutMs: 5000 });
      const starting = controller.start();
      // The start rejects once cancelled below; listen before that happens.
      const startRejected = expect(starting).rejects.toThrow("cancelled");
      await expect.poll(() => calls().some((call) => call.args.join(" ") === "auth login")).toBe(true);
      await expect(controller.signOut()).rejects.toThrow("sign-in in progress");
      await expect(create("success").signOut()).rejects.toThrow("sign-in is running");
      expect(calls().map((call) => call.args)).not.toContainEqual(["auth", "logout"]);
      await controller.cancel();
      await startRejected;
    });

    it("fails closed when Claude Code still reports a login, or cannot answer", async () => {
      signedIn();
      await expect(create("logout-lies").signOut()).rejects.toThrow("still reports a sign-in");
      await expect(create("status-broken").signOut()).rejects.toThrow("could not confirm the sign-out");
    });

    it("stops a hung logout and releases the credential home", async () => {
      signedIn();
      await expect(create("logout-hang", { startupTimeoutMs: 200 }).signOut()).rejects.toThrow("still reports a sign-in");
      await expect(create("success").signOut()).resolves.toBeUndefined();
      expect(existsSync(join(home, "authenticated"))).toBe(false);
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

    it("does not accept a failed status command as proof of sign-out", async () => {
      signedIn();
      await expect(create("status-error-out").signOut()).rejects.toThrow("could not confirm the sign-out");
    });

    it("names a missing CLI and a removed provider plainly", async () => {
      await expect(create("success", { cli: join(home, "missing-claude") }).signOut()).rejects.toThrow("not installed on this server");
      const controller = create("success");
      await controller.dispose();
      await expect(controller.signOut()).rejects.toThrow("provider was removed");
    });
  });

  it("does not replace a working login", async () => {
    const controller = create("already");
    expect((await controller.start()).phase).toBe("succeeded");
    expect(calls().map((call) => call.args)).toEqual([["auth", "status", "--json"]]);
  });

  it("never shows a link that is not Anthropic's, and times out instead", async () => {
    const controller = create("evil");
    await expect(controller.start()).rejects.toThrow(/did not show a sign-in link/);
  });

  it("times out when the CLI prints no link, and cancel kills the process", async () => {
    const controller = create("no-url", { startupTimeoutMs: 20_000 });
    // the rejection lands during cancel(); the expectation must already be listening
    const started = expect(controller.start()).rejects.toThrow(/cancelled/);
    await expect.poll(() => { try { return readFileSync(join(home, "pid"), "utf8").length > 0; } catch { return false; } }).toBe(true);
    const pid = Number(readFileSync(join(home, "pid"), "utf8"));
    await controller.cancel();
    await started;
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("fails safely when the configured executable is missing", async () => {
    const controller = create("success", { cli: join(home, "missing-claude") });
    await expect(controller.start()).rejects.toThrow(/not installed|could not start|did not show/);
  });
});
