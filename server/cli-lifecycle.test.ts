import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWorkspaceRunning, runOnboardingCommand, runServe, type CliOptions } from "./cli.ts";
import { qrToString } from "./cli-pairing.ts";
import { freePortBlock } from "./testing/ports.ts";

const mocks = vi.hoisted(() => ({
  // the fleet path is off in these tests: no credential in the environment
  fleetCredential: vi.fn(() => null),
  fleetAccess: vi.fn(),
  FLEET_CREDENTIAL_ENV: "OMB_INSTALLATION_CREDENTIAL",
  denyLogOpen: false,
  spawn: vi.fn(),
  tailscaleStatus: vi.fn(), tailscaleServe: vi.fn(), tailscaleStop: vi.fn(), clearLeftoverTailscaleServe: vi.fn(), tailnetListenFallback: vi.fn(),
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
  tailscaleStatus: mocks.tailscaleStatus, tailscaleServe: mocks.tailscaleServe, tailnetListenFallback: mocks.tailnetListenFallback,
  clearLeftoverTailscaleServe: mocks.clearLeftoverTailscaleServe, explainTailscaleFailure: (failure: string) => failure,
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
const portBlockers: TcpServer[] = [];

/** A real listener holding a port, the way a foreign process would. */
function holdPort(port: number): Promise<TcpServer> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
    portBlockers.push(server);
  });
}

function spawnEnv(call: number): NodeJS.ProcessEnv {
  const [, , spawnOptions] = mocks.spawn.mock.calls[call] as [string, string[], { env: NodeJS.ProcessEnv }];
  return spawnOptions.env;
}

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
  mocks.tailscaleServe.mockResolvedValue({ origin: "https://fixture.tail.test", stop: mocks.tailscaleStop });
  mocks.tailscaleStop.mockResolvedValue(undefined);
  mocks.tailnetListenFallback.mockReturnValue(null);
  mocks.clearLeftoverTailscaleServe.mockResolvedValue(false);
  mocks.createTunnelAccount.mockReturnValue({ credentials: { status: "available", read: () => ({}) }, service: { retry: async () => ({}), restore: async () => ({}), dispose: vi.fn() } });
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
  for (const blocker of portBlockers.splice(0)) blocker.close();
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
  it("passes OMB_PORT_PINNED to the server child and returns promptly when the child exits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    mocks.spawn.mockImplementation(() => {
      const child = childProcess();
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    });
    const log = vi.fn();
    expect(await runServe(options, log)).toBe(1);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(spawnEnv(0).OMB_PORT_PINNED).toBe("1");
    expect(spawnEnv(0).OMB_PORT).toBe(String(options.port));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenMausBot could not start"));
  });

  it("negotiates the next free port pair when the requested ports are taken", async () => {
    const base = await freePortBlock([0, 1, 2, 3]);
    await holdPort(base);
    await holdPort(base + 1);
    options = { ...options, port: base };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      // The pre-launch check on the requested port finds a foreign server.
      if (address === `http://127.0.0.1:${base}/api/health`) return Response.json({}, { status: 503 });
      if (address.endsWith("/api/health")) return Response.json({ app: "openmausbot", pid: childPid });
      if (address.endsWith("/api/webhooks")) return Response.json({ ingress: { available: true, baseUrl: `http://127.0.0.1:${base + 3}` } });
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const log = vi.fn((line: string) => { if (line.includes("Keep this terminal open")) interrupt(); });
    expect(await runServe(options, log)).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(spawnEnv(0).OMB_PORT).toBe(String(base + 2));
    expect(spawnEnv(0).OMB_WEBHOOK_PORT).toBe(String(base + 3));
    expect(spawnEnv(0).OMB_PORT_PINNED).toBe("1");
    expect(log).toHaveBeenCalledWith(`note: port ${base} is in use; using http://127.0.0.1:${base + 2}`);
    expect(log).toHaveBeenCalledWith(`Listening on 127.0.0.1:${base + 2}, reachable from this machine only.`);
  });

  it("relaunches on the next free pair when the negotiated port is claimed during startup", async () => {
    const base = await freePortBlock([0, 1, 2]);
    options = { ...options, port: base };
    mocks.spawn.mockImplementation(() => {
      const child = childProcess();
      if (mocks.spawn.mock.calls.length === 1) {
        // A third party claims the negotiated port in the probe→bind gap, so
        // the pinned child exits like a real EADDRINUSE crash.
        void holdPort(base).then(() => child.emit("exit", 1, null));
      }
      return child;
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      // The stolen port never serves our child; only the relaunched one does.
      if (address === `http://127.0.0.1:${base}/api/health`) return Response.json({}, { status: 503 });
      if (address.endsWith("/api/health")) return Response.json({ app: "openmausbot", pid: childPid });
      if (address.endsWith("/api/webhooks")) return Response.json({ ingress: { available: true, baseUrl: `http://127.0.0.1:${base + 2}` } });
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const log = vi.fn((line: string) => { if (line.includes("Keep this terminal open")) interrupt(); });
    expect(await runServe(options, log)).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1).OMB_PORT).toBe(String(base + 1));
    expect(spawnEnv(1).OMB_WEBHOOK_PORT).toBe(String(base + 2));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`port ${base} was claimed while the server was starting`));
    expect(log).toHaveBeenCalledWith(`Listening on 127.0.0.1:${base + 1}, reachable from this machine only.`);
  });

  it("relaunches on a fresh pair when the negotiated webhook port is claimed during startup", async () => {
    const base = await freePortBlock([0, 1, 2]);
    options = { ...options, port: base };
    let healthCalls = 0;
    let webhookCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        // The first health probe is the already-running check on the
        // requested port; after that the child answers on the resolved port.
        return ++healthCalls === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.endsWith("/api/webhooks")) {
        if (++webhookCalls === 1) {
          // The child reports its webhook bind lost the race to a third party.
          await holdPort(base + 1);
          return Response.json({ ingress: { available: false } });
        }
        return Response.json({ ingress: { available: true, baseUrl: `http://127.0.0.1:${base + 2}` } });
      }
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const log = vi.fn((line: string) => { if (line.includes("Keep this terminal open")) interrupt(); });
    expect(await runServe(options, log)).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    // The first child was stopped and the relaunch keeps the main port — only
    // the webhook port moves.
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnEnv(1).OMB_PORT).toBe(String(base));
    expect(spawnEnv(1).OMB_WEBHOOK_PORT).toBe(String(base + 2));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`webhook port ${base + 1} was claimed`));
    expect(log).toHaveBeenCalledWith(`Listening on 127.0.0.1:${base}, reachable from this machine only.`);
  });

  it("fails startup when the negotiated webhook port is still foreign-held on the last attempt", async () => {
    const base = await freePortBlock([0, 1, 2, 3, 4, 5]);
    options = { ...options, port: base };
    let healthCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        return ++healthCalls === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.endsWith("/api/webhooks")) {
        // Every attempt loses its negotiated webhook port to a third party:
        // a proxy started now would forward hooks to a foreign process.
        await holdPort(Number(spawnEnv(mocks.spawn.mock.calls.length - 1).OMB_WEBHOOK_PORT));
        return Response.json({ ingress: { available: false } });
      }
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runServe(options, vi.fn())).toBe(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(5);
    for (const child of children) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`webhook port ${base + 5} is owned by another process`));
    error.mockRestore();
  });

  it("relaunches when the child reports no webhook receiver even though the port reads free", async () => {
    const base = await freePortBlock([0, 1, 2, 3, 4, 5]);
    options = { ...options, port: base };
    let healthCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        // The first health probe is the already-running check on the requested port.
        return ++healthCalls === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.endsWith("/api/webhooks")) {
        // The receiver failed for a reason other than a held port (a claim or
        // socket failure): the port probe reads free, but Caddy and Tailscale
        // would still forward hooks to a port with no listener.
        return Response.json({ ingress: { available: false } });
      }
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = runServe(options, vi.fn());
    const exitTimer = setTimeout(() => children[0]?.emit("exit", 0, null), 2_000);
    exitTimer.unref();
    expect(await run).toBe(1);
    clearTimeout(exitTimer);
    expect(mocks.spawn).toHaveBeenCalledTimes(5);
    for (const child of children) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("webhook receiver did not come up"));
    error.mockRestore();
  });

  it("waits out a webhook receiver that is still binding instead of relaunching", async () => {
    const base = await freePortBlock([0, 1]);
    options = { ...options, port: base };
    let healthCalls = 0, ingressCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        // The first health probe is the already-running check on the requested port.
        return ++healthCalls === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.endsWith("/api/webhooks")) {
        // The receiver binds right after the main socket accepts, so the first
        // probes can land mid-walk: "starting" is pending, not down.
        return ++ingressCalls < 3
          ? Response.json({ ingress: { available: false, baseUrl: "", error: "the server is still starting", starting: true } })
          : Response.json({ ingress: { available: true, baseUrl: `http://127.0.0.1:${base + 1}` } });
      }
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const log = vi.fn((line: string) => { if (line.includes("Keep this terminal open")) interrupt(); });
    expect(await runServe(options, log)).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(ingressCalls).toBe(3);
    expect(log).toHaveBeenCalledWith(`Listening on 127.0.0.1:${base}, reachable from this machine only.`);
  });

  it("does not report ready when shutdown begins while the ingress probe is pending", async () => {
    const base = await freePortBlock([0, 1]);
    options = { ...options, port: base };
    let healthCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        // The first health probe is the already-running check on the requested port.
        return ++healthCalls === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.endsWith("/api/webhooks")) {
        interrupt();
        return Response.json({ ingress: { available: true, baseUrl: `http://127.0.0.1:${base + 1}` } });
      }
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const log = vi.fn();
    expect(await runServe(options, log)).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    // The launcher must return through the stopping path: the ready path would
    // start Caddy after teardown already skipped it.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("MausBot "));
  });

  it("stops the Tailscale share when the pinned child exits before readiness", async () => {
    const base = await freePortBlock([0, 1]);
    options = { ...options, port: base, tailscale: true };
    const shareStop = vi.fn().mockResolvedValue(undefined);
    mocks.tailscaleServe.mockResolvedValue({ origin: "https://fixture.tail.test", stop: shareStop });
    mocks.spawn.mockImplementation(() => {
      const child = childProcess();
      // A dead child whose port reads free is a plain startup failure: the
      // launcher's exit path still has to run teardown for the share it raised.
      setTimeout(() => child.emit("exit", 1, null), 0);
      return child;
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) return Response.json({}, { status: 503 });
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runServe(options, vi.fn())).toBe(1);
    expect(shareStop).toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects a webhook port below 1 before negotiating", async () => {
    vi.stubEnv("OMB_WEBHOOK_PORT", "0");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runServe(options, vi.fn())).toBe(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("OMB_WEBHOOK_PORT"));
    error.mockRestore();
  });

  it("does not spawn a retry child when shutdown begins during relaunch negotiation", async () => {
    const base = await freePortBlock([0, 1]);
    options = { ...options, port: base, tailscale: true };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.endsWith("/api/health")) return Response.json({}, { status: 503 });
      throw new Error(`Unexpected fixture request: ${address}`);
    }));
    mocks.spawn.mockImplementation(() => {
      const child = childProcess();
      if (mocks.spawn.mock.calls.length === 1) {
        // The negotiated main port is stolen before the child binds.
        void holdPort(base).then(() => child.emit("exit", 1, null));
      }
      return child;
    });
    const shareStops: ReturnType<typeof vi.fn>[] = [];
    mocks.tailscaleServe.mockImplementation(async () => {
      if (mocks.tailscaleServe.mock.calls.length === 2) interrupt();
      // Each attempt's share gets its own stop spy: one shared spy could not
      // tell a leaked second share from the stopped first one.
      const stop = vi.fn().mockResolvedValue(undefined);
      shareStops.push(stop);
      return { origin: "https://fixture.tail.test", stop };
    });
    expect(await runServe(options, vi.fn())).toBe(130);
    // The retry never reached spawn: onSignal already disarmed cancelStartup,
    // so only the stopping check can veto it.
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(shareStops).toHaveLength(2);
    for (const stop of shareStops) expect(stop).toHaveBeenCalled();
  });

  it("does not enable Tailscale or spawn a server when guided logs cannot be opened", async () => {
    mocks.denyLogOpen = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    await expect(runServe({ ...options, tailscale: true }, vi.fn())).rejects.toMatchObject({ code: "EACCES" });
    expect(mocks.tailscaleServe).not.toHaveBeenCalled();
    expect(mocks.tailscaleStop).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("turns Tailscale back off if spawning the server fails after enabling serve", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    mocks.spawn.mockImplementation(() => { throw new Error("Fixture spawn failure"); });
    await expect(runServe({ ...options, tailscale: true }, vi.fn())).rejects.toThrow("Fixture spawn failure");
    expect(mocks.tailscaleServe).toHaveBeenCalledOnce();
    expect(mocks.tailscaleStop).toHaveBeenCalledOnce();
  });

  it("starts the server on the tailnet when tailscale serve can't front it, with nothing of Tailscale's to stop", async () => {
    mocks.tailscaleServe.mockResolvedValue({ failure: "https-not-enabled" });
    mocks.tailnetListenFallback.mockReturnValue({ origin: "http://fixture.tail.ts.net:18451", env: { OMB_TAILNET_NAME: "fixture.tail.ts.net" }, line: "tailscale: listening" });
    let started: NodeJS.ProcessEnv = {};
    mocks.spawn.mockImplementation((_command: string, _args: string[], spawned: { env: NodeJS.ProcessEnv }) => { started = spawned.env; throw new Error("Fixture spawn failure"); });
    const log = vi.fn();
    await expect(runServe({ ...options, tailscale: true }, log)).rejects.toThrow("Fixture spawn failure");
    expect(started).toMatchObject({ OMB_TAILNET_NAME: "fixture.tail.ts.net", OMB_PUBLIC_URL: "http://fixture.tail.ts.net:18451" });
    expect(log).toHaveBeenCalledWith("tailscale: listening");
    expect(mocks.tailscaleStop).not.toHaveBeenCalled();
  });

  it("stops with Tailscale's reason when listening on the tailnet can't help either", async () => {
    mocks.tailscaleServe.mockResolvedValue({ failure: "unknown" });
    await expect(runServe({ ...options, tailscale: true }, vi.fn())).rejects.toThrow("--tailscale: ");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "success", result: { origin: "https://fixture.tail.test", stop: mocks.tailscaleStop }, stops: 1 },
    { outcome: "failure", result: { failure: "unknown" }, stops: 0 },
  ])("cleans up and never spawns when Tailscale returns $outcome after startup cancellation", async ({ result, stops }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    mocks.tailscaleServe.mockImplementation(async () => {
      await Promise.resolve();
      interrupt();
      return result;
    });
    expect(await runServe({ ...options, tailscale: true }, vi.fn())).toBe(130);
    expect(mocks.tailscaleServe).toHaveBeenCalledOnce();
    expect(mocks.tailscaleStop).toHaveBeenCalledTimes(stops);
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

  it("hands the running tunnel to background endpoint recovery and takes it back on stop", async () => {
    let healthRequests = 0;
    // Nothing answers before serve starts its server; then it is up.
    vi.stubGlobal("fetch", vi.fn(async () => (++healthRequests === 1
      ? Response.json({}, { status: 503 })
      : Response.json({ app: "openmausbot", pid: childPid }))));
    const service = { retry: vi.fn(async () => ({})), restore: vi.fn(), dispose: vi.fn() };
    mocks.createTunnelAccount.mockReturnValue({ credentials: { status: "available", read: () => ({}) }, service });
    const running = { started: Promise.resolve(), stop: vi.fn().mockResolvedValue(undefined) };
    mocks.startTunnel.mockImplementation(() => {
      setTimeout(interrupt, 10);
      return running;
    });
    let servingAtRestore: unknown = "not called";
    service.restore.mockImplementation(async () => {
      servingAtRestore = recovery().running();
      return {};
    });
    const recovery = () => mocks.createTunnelAccount.mock.calls[0]![0].recovery as { running(): unknown };

    expect(await runServe({ ...options, tunnel: true }, vi.fn())).toBe(0);
    expect(mocks.startTunnel).toHaveBeenCalledOnce();
    expect(service.restore).toHaveBeenCalledOnce();
    expect(servingAtRestore).toBe(running);
    expect(recovery().running()).toBeNull();
    expect(service.dispose).toHaveBeenCalled();
    expect(running.stop).toHaveBeenCalledOnce();
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

  it.each([true, false])("with no way in: the guided start signs a browser here in; serve lists the ways in and mints nothing (guided: %s)", async (guided) => {
    let healthRequests = 0;
    const code = "ABCD-EFGH-JKLM";
    const pairings: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        return ++healthRequests === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address.endsWith("/.well-known/openmausbot/environment")) return Response.json({ environmentId: workspaceId, label: "fixture box" });
      expect(address).toBe(`http://127.0.0.1:${options.port}/api/auth/pairing`);
      expect(init?.method).toBe("POST");
      pairings.push(JSON.parse(String(init?.body)));
      return Response.json({ code, url: null, expiresAt: Date.now() + 120_000 });
    }));
    const log = vi.fn((line: string) => { if (line.includes(guided ? "Keep this terminal open" : "Sign in from a browser on this machine")) interrupt(); });
    expect(await runServe({ ...options, guided, pair: true }, log)).toBe(0);
    const output = log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain('server "fixture box"');
    expect(pairings).toEqual(guided ? [{}] : []);
    expect(output.includes(`http://127.0.0.1:${options.port}/pair#code=${code}`)).toBe(guided);
    expect(output.includes("Sign in from a browser on this computer")).toBe(guided);
    expect(output.includes("serve --lan                      this network only, not encrypted")).toBe(!guided);
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
    // A real server mints both encodings of one window; Android can only scan the openmausbot:// one.
    const credential = `omb_pair_${"a".repeat(43)}`;
    const inviteUrl = `openmausbot://pair?address=${encodeURIComponent(origin)}&token=${credential}&name=fixture`;
    let healthRequests = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if (address.endsWith("/api/health")) {
        return ++healthRequests === 1 ? Response.json({}, { status: 503 }) : Response.json({ app: "openmausbot", pid: childPid });
      }
      if (address === `http://127.0.0.1:${options.port}/api/auth/pairing`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ label: "Android", scopes: ["client"] });
        // A server started without OMB_PUBLIC_URL: it mints the credential but
        // cannot name itself, so it returns no links at all. The CLI was told
        // the public address with --public-url and must build both from that.
        return Response.json({ code, url: null, expiresAt, credential, serverName: "fixture", hint: "set OMB_PUBLIC_URL" });
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
    expect(output).toContain(`Pairing code   ${code}   works once, until`);
    expect(output).toContain("· chat and approvals");
    expect(output).toContain(`Link           ${pairingUrl}`);
    expect(output).toMatch(/[▀▄█]/);
    expect(output).toContain(`Or open ${origin}/pair on your phone and enter the code.`);
    expect(output).toContain("On Android, open the OpenMausBot app and scan the QR with its pairing scanner.");
    expect(output).toContain(qrToString(inviteUrl));
    expect(output).not.toContain(qrToString(pairingUrl));
    expect(output).toContain("client access: chat and approvals, not settings or pairing administration");
    expect(output).toContain("Scanning a QR does not mean the phone is paired.");
    expect(output).toContain("Waiting for you to connect on the phone.");
    expect(output).not.toMatch(/pairing complete|phone (?:is |successfully )?connected|paired successfully/i);
  });
});
