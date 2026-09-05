import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLogin, runLogout, runStatus, type CliIo, type CliOptions } from "./cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";
import {
  cleanupTunnelOrigin,
  createTunnelOrigin,
  describeTunnelAccount,
  describeTunnelState,
  guardianEntry,
  openTunnelCredentials,
  platformName,
  prepareEntry,
  startTunnel,
  TUNNEL_CREDENTIALS_FILE,
  tunnelAccess,
} from "./tunnel.ts";

const posix = process.platform !== "win32";

function options(dataDir: string, extra: Partial<CliOptions> = {}): CliOptions {
  return { command: "login", port: 1, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false, ...extra };
}

function fakeIo(answers: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { log: (line) => out.push(line), error: (line) => err.push(line), ask: async () => answers.shift() ?? "" };
  return { io, out, err };
}

describe("tunnel credentials: a private file, and unreadable is not empty", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-tunnel-cred-"));
  });
  afterEach(() => removeTempDir(dir));

  it("starts empty, writes 0600, and re-tightens a loosened file on open", async () => {
    const fresh = openTunnelCredentials(dir);
    expect(fresh.status).toBe("empty");
    await fresh.update((doc) => ({ ...doc, hello: "world" }));
    const file = join(dir, TUNNEL_CREDENTIALS_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hello: "world" });
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      chmodSync(file, 0o644);
      expect(openTunnelCredentials(dir).status).toBe("ok");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(openTunnelCredentials(dir).read()).toEqual({ hello: "world" });
  });

  it("refuses to write over a file it could not read, so a real account is never replaced by a fresh one", async () => {
    writeFileSync(join(dir, TUNNEL_CREDENTIALS_FILE), "{not json");
    const broken = openTunnelCredentials(dir);
    expect(broken.status).toBe("unavailable");
    await expect(broken.update((doc) => ({ ...doc, x: 1 }))).rejects.toThrow(/could not be read/);
    expect(readFileSync(join(dir, TUNNEL_CREDENTIALS_FILE), "utf8")).toBe("{not json");
  });
});

describe("login and logout against the control plane", () => {
  let dir: string;
  let stub: ControlPlaneStub;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-tunnel-login-"));
    stub = await startControlPlaneStub();
    vi.stubEnv("OMB_CONTROL_PLANE_URL", stub.url);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await stub.close();
    await removeTempDir(dir);
  });

  it("an emailed code signs this machine in and reserves its public address; logout releases it", async () => {
    const wrong = fakeIo(["00000000"]);
    expect(await runLogin(options(dir, { email: "milind@example.test" }), wrong.io)).toBe(1);
    expect(wrong.err.join("\n")).toMatch(/sign-in failed/);
    expect(describeTunnelAccount(openTunnelCredentials(dir).read()).email).toBeNull();

    const right = fakeIo([stub.otp]);
    expect(await runLogin(options(dir, { email: "milind@example.test" }), right.io)).toBe(0);
    expect(right.out.join("\n")).toContain(`This machine's public address: ${stub.endpointUrl}`);
    const doc = openTunnelCredentials(dir).read();
    expect(describeTunnelAccount(doc)).toMatchObject({ email: "milind@example.test", address: stub.endpointUrl });
    expect(tunnelAccess(doc)?.token).toBe(stub.connectorToken);
    expect(stub.calls).toContain("POST /v1/installations");
    expect(stub.calls).toContain("POST /v1/installations/self/endpoint");
    expect([...stub.installations.values()][0]).toMatchObject({ platform: platformName() });
    if (posix) expect(statSync(join(dir, TUNNEL_CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);

    // status mentions the address without touching the network
    const status = fakeIo([]);
    await runStatus(options(dir, { command: "status" }), status.io);
    expect(status.out.join("\n")).toContain(`public address: ${stub.endpointUrl}`);

    const bye = fakeIo([]);
    expect(await runLogout(options(dir, { command: "logout" }), bye.io)).toBe(0);
    expect(bye.out.join("\n")).toContain("is released");
    expect(describeTunnelAccount(openTunnelCredentials(dir).read()).email).toBeNull();
    expect(stub.calls).toContain("DELETE /v1/installations/self/endpoint");
    expect(stub.calls).toContain("POST /api/auth/sign-out");
  });

  it("an unusable control-plane override is a clear error, not a silent default", async () => {
    vi.stubEnv("OMB_CONTROL_PLANE_URL", "ftp://nope");
    const io = fakeIo([]);
    expect(await runLogin(options(dir, { email: "a@b.test" }), io.io)).toBe(1);
    expect(io.err.join("\n")).toMatch(/OMB_CONTROL_PLANE_URL/);
  });
});

describe("where the pieces are", () => {
  it("names the platform the control plane's way and prefers the bundled guardian and downloader", () => {
    expect(platformName("darwin")).toBe("darwin");
    expect(platformName("win32")).toBe("windows");
    expect(platformName("linux")).toBe("linux");
    const bundled = mkdtempSync(join(tmpdir(), "omb-tunnel-bundled-"));
    try {
      expect(guardianEntry(bundled)).toBeNull();
      writeFileSync(join(bundled, "tunnel-guardian.js"), "");
      expect(guardianEntry(bundled)).toBe(join(bundled, "tunnel-guardian.js"));
      expect(prepareEntry(bundled)).toMatch(/scripts[\\/]prepare-cloudflared\.mjs$/);
      writeFileSync(join(bundled, "prepare-cloudflared.js"), "");
      expect(prepareEntry(bundled)).toBe(join(bundled, "prepare-cloudflared.js"));
    } finally {
      void removeTempDir(bundled);
    }
    // a checkout: the source files
    expect(guardianEntry()).toMatch(/managed-companion-guardian-main\.mjs$/);
  });

  it("describes tunnel states in one line each", () => {
    expect(describeTunnelState({ status: "starting", ready: false }, "https://c-1.example")).toBe("tunnel: connecting…");
    expect(describeTunnelState({ status: "ready", ready: true }, "https://c-1.example")).toBe("tunnel: live at https://c-1.example");
    expect(describeTunnelState({ status: "retrying", ready: false, error: "The secure connection could not be verified.", retryInMs: 4000 }, "x")).toBe(
      "tunnel: The secure connection could not be verified. retrying in 4s",
    );
    expect(describeTunnelState({ status: "unavailable", ready: false, error: "no connector" }, "x")).toBe("tunnel: no connector");
  });
});

describe.skipIf(!posix)("startTunnel: guardian, gateway and connector, verified through the gateway", () => {
  it("forwards the public address to the harness socket (no peer address = remote) and tears everything down on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-tunnel-run-"));
    const origin = createTunnelOrigin();
    const pidFile = join(dir, "connector.pid");
    const fake = join(dir, "cloudflared");
    writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`, { mode: 0o755 });
    const harness = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "openmausbot", url: req.url, peer: req.socket.remoteAddress ?? null }));
    });
    await new Promise<void>((done) => harness.listen(origin.socketPath, done));
    const originPort = 20000 + Math.floor(Math.random() * 20000);
    const endpoint = "https://c-stub.openmausbot.invalid";
    const guardian = guardianEntry();
    expect(guardian).toBeTruthy();
    const states: string[] = [];
    const tunnel = startTunnel({
      dataDir: dir,
      access: { endpoint, token: `connector-${"t".repeat(60)}` },
      originTarget: { pid: process.pid, socketPath: origin.socketPath },
      binaryPath: fake,
      guardian: guardian ?? "",
      env: { ...process.env, OMB_TUNNEL_ORIGIN_PORT: String(originPort) },
      // the public address does not exist here; verify through the gateway instead
      fetchImpl: (input, init) => fetch(String(input).replace(endpoint, `http://127.0.0.1:${originPort}`), init),
      onState: (state) => states.push(state.status),
    });
    try {
      const settled = await tunnel.started;
      expect(settled.status, states.join(",")).toBe("ready");
      const viaGateway: any = await (await fetch(`http://127.0.0.1:${originPort}/api/health`)).json();
      expect(viaGateway.app).toBe("openmausbot");
      expect(viaGateway.peer).toBeNull();
      // the connector is spawned right after the gateway binds; its shell writes the pid a moment later
      let connectorPid = 0;
      for (let tries = 0; tries < 50 && !connectorPid; tries += 1) {
        connectorPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
        if (!connectorPid) await new Promise((r) => setTimeout(r, 100));
      }
      expect(connectorPid).toBeGreaterThan(0);
      await tunnel.stop();
      expect(tunnel.state().status).toBe("stopped");
      await new Promise((r) => setTimeout(r, 300));
      expect(() => process.kill(connectorPid, 0)).toThrow();
      await expect(fetch(`http://127.0.0.1:${originPort}/api/health`)).rejects.toThrow();
    } finally {
      await tunnel.stop().catch(() => undefined);
      harness.close();
      cleanupTunnelOrigin(origin);
      await removeTempDir(dir);
    }
  }, 30_000);
});
