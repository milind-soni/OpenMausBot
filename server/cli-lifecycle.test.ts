import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWorkspaceRunning, runOnboardingCommand, runServe, type CliOptions } from "./cli.ts";

const mocks = vi.hoisted(() => ({
  // the fleet path is off in these tests: no credential in the environment
  fleetCredential: vi.fn(() => null),
  fleetAccess: vi.fn(),
  FLEET_CREDENTIAL_ENV: "OMB_INSTALLATION_CREDENTIAL",
  denyLogOpen: false,
  spawn: vi.fn(),
  tailscaleStatus: vi.fn(), tailscaleServe: vi.fn(), tailscaleServeOff: vi.fn(),
  createTunnelAccount: vi.fn(), createTunnelOrigin: vi.fn(), cleanupTunnelOrigin: vi.fn(),
  describeTunnelAccount: vi.fn(), tunnelAccess: vi.fn(), ensureCloudflared: vi.fn(),
  guardianEntry: vi.fn(), startTunnel: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (mocks.denyLogOpen && String(args[0]).endsWith(".log")) {
        throw Object.assign(new Error("Fixture log permission denied"), { code: "EACCES" });
      }
      return fs.openSync(...args);
    },
  };
});
vi.mock("./tailscale.ts", () => ({
  tailscaleStatus: mocks.tailscaleStatus, tailscaleServe: mocks.tailscaleServe,
  tailscaleServeOff: mocks.tailscaleServeOff, explainTailscaleFailure: (failure: string) => failure,
}));
vi.mock("./tunnel.ts", () => ({ ...mocks, describeTunnelState: () => "Fixture tunnel" }));
vi.mock("./browser-engine.ts", () => ({
  browserEngineStatus: () => ({ kind: "ready" }), describeBrowserEngine: () => "Fixture browser ready",
}));
vi.mock("./cli-setup.ts", () => ({
  runSetup: () => { throw new Error("An existing workspace must not rerun setup"); },
}));

const workspaceId = "4e406646-1030-4613-8878-e227ab722ffc";
const childPid = process.pid + 1;
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
let dataDir: string;
let options: CliOptions;
let signalListeners: Map<NodeJS.Signals, Set<unknown>>;
const children: ChildProcess[] = [];

function childProcess(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: childPid,
    kill: vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    }),
  }) as unknown as ChildProcess;
  children.push(child);
  return child;
}

// Invoke only the handler installed by runServe, never signal the test runner
// or another process. The child is an EventEmitter, not a real subprocess.
function interrupt(): void {
  const handlers = process.listeners("SIGINT").filter((handler) => !signalListeners.get("SIGINT")?.has(handler));
  expect(handlers).toHaveLength(1);
  handlers[0]!("SIGINT");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.denyLogOpen = false;
  dataDir = mkdtempSync(join(process.env.HOME!, "cli-lifecycle-"));
  options = { command: "serve", port: 18451, dataDir, tailscale: false, tunnel: false, client: false, pair: false, json: false, guided: true, open: false };
  signalListeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal as NodeJS.Signals, new Set(process.listeners(signal))]));
  mocks.spawn.mockImplementation(() => childProcess());
  mocks.tailscaleStatus.mockResolvedValue({ status: { cli: "/fixture/tailscale", dnsName: "fixture.tail.test", addresses: [], backendState: "Running" } });
  mocks.tailscaleServe.mockResolvedValue({ origin: "https://fixture.tail.test" });
  mocks.tailscaleServeOff.mockResolvedValue(undefined);
  mocks.createTunnelAccount.mockReturnValue({ credentials: { status: "available", read: () => ({}) }, service: { retry: async () => ({}) } });
  mocks.describeTunnelAccount.mockReturnValue({ email: "fixture@example.test" });
  mocks.tunnelAccess.mockReturnValue({ endpoint: "https://fixture.openmausbot.test" });
  mocks.ensureCloudflared.mockResolvedValue("/fixture/cloudflared");
  mocks.guardianEntry.mockReturnValue("/fixture/guardian");
  mocks.createTunnelOrigin.mockReturnValue({ socketPath: join(dataDir, "fixture.sock") });
  mocks.startTunnel.mockReturnValue({ started: Promise.resolve(), stop: vi.fn().mockResolvedValue(undefined) });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected fixture request"); }));
});

afterEach(() => {
  for (const child of children.splice(0)) child.emit("exit", 0, null);
  for (const [signal, before] of signalListeners) {
    for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [index, stream] of [process.stdin, process.stdout].entries()) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CLI startup lifecycle", () => {
  it("does not enable Tailscale or spawn a server when guided logs cannot be opened", async () => {
    mocks.denyLogOpen = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    await expect(runServe({ ...options, tailscale: true }, vi.fn())).rejects.toMatchObject({ code: "EACCES" });
    expect(mocks.tailscaleServe).not.toHaveBeenCalled();
    expect(mocks.tailscaleServeOff).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("turns Tailscale back off if spawning the server fails after enabling serve", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    mocks.spawn.mockImplementation(() => { throw new Error("Fixture spawn failure"); });
    await expect(runServe({ ...options, tailscale: true }, vi.fn())).rejects.toThrow("Fixture spawn failure");
    expect(mocks.tailscaleServe).toHaveBeenCalledOnce();
    expect(mocks.tailscaleServeOff).toHaveBeenCalledOnce();
    expect(mocks.tailscaleServeOff).toHaveBeenCalledWith(expect.objectContaining({ dnsName: "fixture.tail.test" }));
  });

  it.each([
    { outcome: "success", result: { origin: "https://fixture.tail.test" } },
    { outcome: "failure", result: { failure: "unknown" } },
  ])("cleans up and never spawns when Tailscale returns $outcome after startup cancellation", async ({ result }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    mocks.tailscaleServe.mockImplementation(async () => {
      await Promise.resolve();
      interrupt();
      return result;
    });
    expect(await runServe({ ...options, tailscale: true }, vi.fn())).toBe(130);
    expect(mocks.tailscaleServe).toHaveBeenCalledOnce();
    expect(mocks.tailscaleServeOff).toHaveBeenCalledOnce();
    expect(mocks.tailscaleServeOff).toHaveBeenCalledWith(expect.objectContaining({ dnsName: "fixture.tail.test" }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    for (const [signal, before] of signalListeners) {
      expect(process.listeners(signal).filter((handler) => !before.has(handler))).toEqual([]);
    }
  });

  it("does not start a tunnel after SIGINT during the final readiness response", async () => {
    let healthRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`http://127.0.0.1:${options.port}/api/health`);
      healthRequests++;
      if (healthRequests === 1) return Response.json({}, { status: 503 });
      if (healthRequests === 3) interrupt();
      return Response.json({ app: "openmausbot", pid: childPid });
    }));
    expect(await runServe({ ...options, tunnel: true }, vi.fn())).toBe(0);
    expect(healthRequests).toBe(3);
    expect(mocks.startTunnel).not.toHaveBeenCalled();
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.cleanupTunnelOrigin).toHaveBeenCalledOnce();
  });

  it("reopens a matching desktop workspace even when its server PID differs from the lease owner", async () => {
    writeFileSync(join(dataDir, "environment-id"), workspaceId);
    writeFileSync(join(dataDir, "openmausbot-server.lease"), JSON.stringify({
      version: 1, pid: process.pid, host: hostname(), token: workspaceId, createdAt: Date.now(),
    }));
    vi.stubEnv("OMB_DATA_DIR", process.env.OMB_DATA_DIR);
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/health")
      ? Response.json({ app: "openmausbot", pid: childPid })
      : Response.json({ environmentId: workspaceId })));
    const start = vi.fn();
    const open = vi.fn().mockResolvedValue(true);
    const io = { log: vi.fn(), error: vi.fn(), ask: vi.fn() };
    expect(await runOnboardingCommand({ ...options, command: "start", open: true }, io, start, { open })).toBe(0);
    expect(open).toHaveBeenCalledWith(options.port);
    expect(start).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not mistake another workspace on the same port for this one", async () => {
    writeFileSync(join(dataDir, "environment-id"), workspaceId);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ app: "openmausbot", pid: childPid }))
      .mockResolvedValueOnce(Response.json({ environmentId: "different-workspace" })));
    expect(await isWorkspaceRunning(options)).toBe(false);
  });

  it.each(["mismatched", "unreachable"])("never mints a phone code for a %s public endpoint", async (failure) => {
    let healthRequests = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      requests.push(address);
      expect(init?.method).not.toBe("POST");
      if (address.endsWith("/api/health")) {
        return ++healthRequests === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.startsWith("https://")) {
        if (failure === "unreachable") throw new Error("Fixture endpoint offline");
        return Response.json({ environmentId: "another-workspace" });
      }
      return Response.json({ environmentId: workspaceId });
    }));
    const log = vi.fn((line: string) => { if (line.includes("Keep this terminal open")) interrupt(); });
    expect(await runServe({ ...options, pair: true, phone: "android", publicUrl: "https://fixture.example.test" }, log)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no phone pairing code was created"));
    expect(requests.some((url) => url.includes("/api/auth/pairing"))).toBe(false);
    expect(requests).toContain("https://fixture.example.test/.well-known/openmausbot/environment");
  });

  it("offers Android client pairing only after verifying the same workspace, without claiming it is connected", async () => {
    const origin = "https://fixture.example.test";
    const code = "ABCD-EFGH-JKLM";
    const expiresAt = Date.now() + 300_000;
    const pairingUrl = `${origin}/pair#code=${code}`;
    let healthRequests = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        return ++healthRequests === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address === `http://127.0.0.1:${options.port}/api/auth/pairing`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ label: "Android", scopes: ["client"] });
        return Response.json({ code, url: pairingUrl, expiresAt });
      }
      expect(address).toMatch(/\/\.well-known\/openmausbot\/environment$/);
      expect(init?.method).not.toBe("POST");
      expect(init?.body).toBeUndefined();
      return Response.json({ environmentId: workspaceId });
    });
    vi.stubGlobal("fetch", fetcher);
    const log = vi.fn((line: string) => { if (line.includes("Keep this terminal open")) interrupt(); });
    expect(await runServe({ ...options, pair: true, phone: "android", publicUrl: origin }, log)).toBe(0);
    const requests = fetcher.mock.calls.map(([url]) => String(url));
    const pairingRequest = `http://127.0.0.1:${options.port}/api/auth/pairing`;
    expect(requests.filter((url) => url === pairingRequest)).toHaveLength(1);
    expect(requests).toContain(`http://127.0.0.1:${options.port}/.well-known/openmausbot/environment`);
    expect(requests).toContain(`${origin}/.well-known/openmausbot/environment`);
    expect(requests.indexOf(`${origin}/.well-known/openmausbot/environment`)).toBeLessThan(requests.indexOf(pairingRequest));
    const output = log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain(`pairing code:  ${code}`);
    expect(output).toContain(`expires:       ${new Date(expiresAt).toLocaleTimeString()} (single use)`);
    expect(output).toContain(`open or scan:  ${pairingUrl}`);
    expect(output).toMatch(/[▀▄█]/);
    expect(output).toContain(`Or open ${origin}/pair on your phone and enter the code.`);
    expect(output).toContain("On Android, scan the QR with Camera and open it in your web browser.");
    expect(output).toContain("not the Android native pairing scanner");
    expect(output).toContain("client access: chat and approvals, not settings or pairing administration");
    expect(output).toContain("Scanning a QR does not mean the phone is paired.");
    expect(output).toContain("Waiting for you to connect on the phone.");
    expect(output).not.toMatch(/pairing complete|phone (?:is |successfully )?connected|paired successfully/i);
  });
});
