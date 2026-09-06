import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { formatSessions, pairingBlock, parseArgs, qrToString, runLogin, serverEntry } from "./cli.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startControlPlaneStub } from "./testing/control-plane-stub.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

describe("openmausbot command line", () => {
  it("parses commands and flags, and explains mistakes", () => {
    const serve = parseArgs(["serve", "--port", "9001", "--data-dir", "/tmp/x", "--label", "cab mini", "--tailscale", "--no-pair"], {});
    // --data-dir is resolved against the platform: C:\tmp\x on Windows.
    expect(serve).toMatchObject({ command: "serve", port: 9001, dataDir: resolve("/tmp/x"), label: "cab mini", tailscale: true, pair: false });
    expect(parseArgs(["pair", "--client", "--public-url", "https://h/"], {})).toMatchObject({ command: "pair", client: true, publicUrl: "https://h" });
    expect(parseArgs(["sessions", "revoke", "abc"], {})).toMatchObject({ command: "sessions", revoke: "abc" });
    expect(parseArgs([], { OMB_PORT: "8123" })).toMatchObject({ command: "help", port: 8123 });
    expect(parseArgs(["dance"], {})).toEqual({ error: 'unknown command "dance"' });
    expect(parseArgs(["serve", "--port"], {})).toEqual({ error: "--port needs a value" });
    expect(parseArgs(["serve", "--port", "70000"], {})).toEqual({ error: "--port must be 1-65535" });
    expect(parseArgs(["pair", "--public-url", "mini.example"], {})).toEqual({ error: "--public-url must start with http:// or https://" });
    expect(parseArgs(["serve", "--bogus"], {})).toEqual({ error: 'unknown argument "--bogus"' });
    expect(parseArgs(["serve", "--tunnel"], {})).toMatchObject({ command: "serve", tunnel: true });
    expect(parseArgs(["login", "--email", "a@b.test"], {})).toMatchObject({ command: "login", email: "a@b.test" });
    expect(parseArgs(["logout"], {})).toMatchObject({ command: "logout" });
    expect(parseArgs(["browser", "install", "--with-deps"], {})).toMatchObject({ command: "browser", browserAction: "install", withDeps: true });
    expect(parseArgs(["browser", "status"], {})).toMatchObject({ command: "browser", browserAction: "status" });
    expect(parseArgs(["browser"], {})).toEqual({ error: "browser needs an action: install or status" });
    expect(parseArgs(["serve", "--tailscale", "--tunnel"], {})).toEqual({ error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" });
  });

  it("prints a scannable block with the link, or says where to type the code", () => {
    const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: "https://mini.example/pair#code=ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    expect(block).toContain("pairing code:  ABCD-EFGH-JKLM");
    expect(block).toContain("open or scan:  https://mini.example/pair#code=ABCD-EFGH-JKLM");
    expect(block).toMatch(/[▀▄█]/);
    const noUrl = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, expiresAt: Date.now(), hint: "set OMB_PUBLIC_URL" });
    expect(noUrl).toContain("/pair on the address you use");
    expect(noUrl).toContain("set OMB_PUBLIC_URL");
    expect(qrToString("https://example.com").length).toBeGreaterThan(200);
  });

  it("lists sessions as a table with relative last-seen times", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    const table = formatSessions([
      { id: "a1", label: "My MacBook", scopes: ["admin", "client"], lastSeenAt: now - 30_000, expiresAt: now + 86_400_000 },
      { id: "b2", label: "", scopes: ["client"], lastSeenAt: now - 3 * 3_600_000, expiresAt: now + 86_400_000 },
    ], now);
    expect(table).toContain("My MacBook");
    expect(table).toContain("(unnamed)");
    expect(table).toMatch(/a1\s+My MacBook\s+admin\s+just now/);
    expect(table).toMatch(/b2\s+\(unnamed\)\s+client\s+3 h ago/);
    expect(table).toContain("sessions revoke <id>");
  });

  it("finds the server next to itself: bundled index.js in a package, the TypeScript source in a checkout", () => {
    const checkout = serverEntry(SERVER_DIR);
    expect(checkout.args[0]).toBe("--experimental-strip-types");
    expect(checkout.args[1]).toBe(join(SERVER_DIR, "index.ts"));
    expect(checkout.skillsDir).toBe(join(SERVER_DIR, "..", "skills"));
  });

  it("serve: starts the server, prints the pairing link, and stops on SIGTERM", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-serve-"));
    const port = 21000 + Math.floor(Math.random() * 9000);
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), "serve", "--port", String(port), "--data-dir", join(home, "data"), "--label", "cli test", "--public-url", "https://mini.example"], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(port + 1), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain(`OpenMausBot is running on http://127.0.0.1:${port}, reachable at https://mini.example`);
      expect(out).toMatch(/pairing code:  [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
      expect(out).toContain("open or scan:  https://mini.example/pair#code=");
      expect(out).toMatch(/[▀▄█]/);
      const descriptor: any = await (await fetch(`http://127.0.0.1:${port}/.well-known/openmausbot/environment`)).json();
      expect(descriptor.label).toBe("cli test");
      const pairing: any = await (await fetch(`http://127.0.0.1:${port}/api/auth/pairing`)).json();
      expect(pairing.pairings.length).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    }
    let dead = false;
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      dead = true;
    }
    expect(dead).toBe(true);
  }, 90_000);
});

const exited = (child: ChildProcess) => (child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise<number | null>((done) => child.once("exit", (code) => done(code))));

describe.skipIf(process.platform === "win32")("serve --tunnel", () => {
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), ...args], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("refuses without an account and says what to do; no local-only fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-tunnel-none-"));
    const port = 21000 + Math.floor(Math.random() * 9000);
    const child = cli(["serve", "--tunnel", "--port", String(port), "--data-dir", join(home, "data")], { HOME: home, USERPROFILE: home });
    let err = "";
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    try {
      expect(await exited(child)).toBe(1);
      expect(err).toContain("run `openmausbot login` first");
      let dead = false;
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
      } catch {
        dead = true;
      }
      expect(dead).toBe(true);
    } finally {
      await removeTempDir(home);
    }
  }, 30_000);

  it("serves at the account's public address through the gateway, where every request is remote", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-tunnel-"));
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const stub = await startControlPlaneStub();
    const fake = join(home, "cloudflared");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    // sign this data dir in, in-process, against the stub
    vi.stubEnv("OMB_CONTROL_PLANE_URL", stub.url);
    const quiet = { log: () => undefined, error: () => undefined, ask: async () => stub.otp };
    expect(await runLogin({ command: "login", port: 1, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false, email: "cli@example.test" }, quiet)).toBe(0);
    vi.unstubAllEnvs();
    const port = 21000 + Math.floor(Math.random() * 9000);
    const originPort = 31000 + Math.floor(Math.random() * 9000);
    const child = cli(["serve", "--tunnel", "--port", String(port), "--data-dir", dataDir, "--label", "tunnel test"], {
      HOME: home,
      USERPROFILE: home,
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"),
      OMB_CONTROL_PLANE_URL: stub.url,
      OMB_CLOUDFLARED_PATH: fake,
      OMB_TUNNEL_ORIGIN_PORT: String(originPort),
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (out += String(chunk)));
    const gateway = `http://127.0.0.1:${originPort}`;
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain(`OpenMausBot is running on http://127.0.0.1:${port}, reachable at ${stub.endpointUrl}`);
      expect(out).toContain(`open or scan:  ${stub.endpointUrl}/pair#code=`);
      // a fresh connector token was fetched for this run
      expect(stub.calls).toContain("POST /v1/installations/self/endpoint");

      // the gateway comes up with the guardian; through it the harness is reachable...
      let descriptor: Response | null = null;
      const gatewayDeadline = Date.now() + 20_000;
      while (Date.now() < gatewayDeadline) {
        try {
          descriptor = await fetch(`${gateway}/.well-known/openmausbot/environment`);
          if (descriptor.status === 200) break;
        } catch {
          descriptor = null;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(descriptor?.status).toBe(200);
      // ...but a request with no headers at all, which the loopback listener would take as the owner, is a stranger here
      const stranger = await fetch(`${gateway}/api/bots`);
      expect(stranger.status).toBe(403);
      expect(((await stranger.json()) as { error: string }).error).toMatch(/through a proxy/);
      expect(await (await fetch(`${gateway}/api/health`)).json()).toEqual({ app: "openmausbot" });
      expect(typeof ((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { pid: unknown }).pid).toBe("number");
      // the printed code pairs a device through the gateway, and its session is honoured there
      const match = /pairing code:  ([A-Z2-9-]+)/.exec(out);
      expect(match).toBeTruthy();
      const paired = await fetch(`${gateway}/api/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ code: match?.[1] ?? "", label: "phone" }),
      });
      expect(paired.status).toBe(200);
      const { token } = (await paired.json()) as { token: string };
      const mine = await fetch(`${gateway}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } });
      expect(mine.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await exited(child);
      await stub.close();
      await removeTempDir(home);
    }
    for (const url of [`${gateway}/api/health`, `http://127.0.0.1:${port}/api/health`]) {
      let dead = false;
      try {
        await fetch(url);
      } catch {
        dead = true;
      }
      expect(dead, url).toBe(true);
    }
  }, 120_000);
});
