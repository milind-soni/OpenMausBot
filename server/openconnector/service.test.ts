import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { OPENCONNECTOR_SERVER } from "../../shared/openconnector.ts";
import { createOpenConnector } from "./service.ts";

let dir: string;
let cfg: Pick<AppConfig, "openconnector" | "mcpServers">;
let busy: boolean;
let launched: Array<{ command: string; args: string[] }>;
let terminated: Array<number | null>;
let livePids: Set<number>;
let forgotten: string[];
let changed: string[];
let nextPid: number;
let world: "up" | "down";
let launchWorks: boolean;
let probeCalls: number;

const okProbe = (tools = 5) => ({ ok: true as const, tools: Array.from({ length: tools }, (_, i) => ({ name: `tool-${i}` })) });
const failProbe = (error = "no answer") => ({ ok: false as const, error, reason: "unreachable" as const });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-openconnector-"));
  cfg = { openconnector: { url: "http://127.0.0.1:3000/mcp", command: "openconnector", args: [] }, mcpServers: {} };
  busy = false;
  launched = [];
  terminated = [];
  livePids = new Set();
  forgotten = [];
  changed = [];
  nextPid = 4000;
  world = "down";
  launchWorks = true;
  probeCalls = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeChild = (pid: number): ChildProcess => ({ pid, once: () => {} }) as unknown as ChildProcess;

const service = (extra: Partial<Parameters<typeof createOpenConnector>[0]> = {}) => createOpenConnector({
  cfg: () => cfg,
  persistMcpServers: (next) => { cfg = { ...cfg, mcpServers: next }; },
  mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
  mcpPolicyRefusal: (_name, server) => (server as { url: string }).url.includes("blocked.example") ? "Your organization allows only approved MCP servers." : undefined,
  appCatalog: { serverChanged: (name) => changed.push(name), forgetServer: (name) => forgotten.push(name) },
  dataDir: dir,
  loopback: true,
  // The fake world: the endpoint answers only while "up"; a working launch brings it up, a terminate brings it down.
  probe: () => {
    probeCalls += 1;
    return Promise.resolve(world === "up" ? okProbe() : failProbe(world === "down" ? "connection refused" : "no answer"));
  },
  launch: (command, args) => {
    const pid = nextPid;
    nextPid += 1;
    launched.push({ command, args });
    livePids.add(pid);
    if (launchWorks) world = "up";
    return fakeChild(pid);
  },
  terminate: (handle, pid) => {
    const target = handle?.pid ?? pid;
    terminated.push(target ?? null);
    if (target) livePids.delete(target);
    world = "down";
    return Promise.resolve();
  },
  alive: (pid) => livePids.has(pid),
  autoHealth: false,
  readyMs: 10,
  readyPollMs: 1,
  ...extra,
});

describe("connect", () => {
  it("adopts a running OpenConnector without starting anything", async () => {
    world = "up";
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.state).toBe("connected");
    expect(result.status.tools).toBe(5);
    expect(result.status.managed).toBe(true);
    expect(result.status.host).toBe("127.0.0.1:3000");
    expect(launched).toEqual([]);
    const entry = cfg.mcpServers?.[OPENCONNECTOR_SERVER] as { type: string; url: string; headers: Record<string, string>; enabled: boolean };
    expect(entry).toEqual({ type: "http", url: "http://127.0.0.1:3000/mcp", headers: {}, enabled: true });
    expect(changed).toContain(OPENCONNECTOR_SERVER);
  });

  it("starts the saved command when nothing answers, and records it for adoption", async () => {
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(launched).toEqual([{ command: "openconnector", args: [] }]);
    expect(result.status.running).toBe(true);
    expect(result.status.pid).toBe(4000);
    expect(result.status.tools).toBe(5);
    const record = JSON.parse(readFileSync(join(dir, "openconnector-process.json"), "utf8")) as { pid: number; command: string; url: string };
    expect(record.pid).toBe(4000);
    expect(record.command).toBe("openconnector");
  });

  it("adopts a live recorded pid instead of starting a second process", async () => {
    writeFileSync(join(dir, "openconnector-process.json"), JSON.stringify({ pid: 4242, command: "openconnector", url: "http://127.0.0.1:3000/mcp", startedAt: 1 }), { mode: 0o600 });
    livePids.add(4242);
    world = "up";
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(launched).toEqual([]);
    expect(result.status.pid).toBe(4242);
  });

  it("refuses with taken when another server owns the name", async () => {
    cfg = { ...cfg, mcpServers: { openconnector: { type: "http", url: "https://elsewhere.example/mcp", headers: {}, enabled: true } } };
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("taken");
    expect(launched).toEqual([]);
    expect(svc.status().state).toBe("taken");
  });

  it("refuses with managed_policy when the organization's policy rejects it", async () => {
    cfg = { ...cfg, openconnector: { url: "https://blocked.example/mcp", command: "" } };
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("managed_policy");
    expect(svc.status().state).toBe("blocked");
  });

  it("connect-only mode fails plainly when the address does not answer", async () => {
    cfg = { ...cfg, openconnector: { url: "http://127.0.0.1:3000/mcp", command: "" } };
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreachable");
    expect(launched).toEqual([]);
    expect(cfg.mcpServers?.[OPENCONNECTOR_SERVER]).toBeUndefined();
    const after = svc.status();
    expect(after.state).toBe("not-connected");
    expect(after.managed).toBe(false);
  });

  it("start_failed when the managed process never answers", async () => {
    launchWorks = false;
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("start_failed");
    expect(launched).toEqual([{ command: "openconnector", args: [] }]);
    expect(svc.status().state).toBe("error");
  });
});

describe("health recovery", () => {
  it("restarts at most three times, then rests in error; check() recovers", async () => {
    world = "up";
    const svc = service();
    expect((await svc.connect()).ok).toBe(true);
    world = "down";
    launchWorks = false;
    for (let tick = 0; tick < 4; tick += 1) await svc.healthTick();
    expect(launched.length).toBe(3);
    expect(svc.status().state).toBe("error");
    expect(svc.status().message).toMatch(/connection refused/u);
    launchWorks = true;
    const after = await svc.check();
    expect(after.state).toBe("connected");
    expect(after.tools).toBe(5);
    expect(launched.length).toBe(4);
  });

  it("stops the recorded pid before restarting when it is alive but silent", async () => {
    writeFileSync(join(dir, "openconnector-process.json"), JSON.stringify({ pid: 4242, command: "openconnector", url: "http://127.0.0.1:3000/mcp", startedAt: 1 }), { mode: 0o600 });
    livePids.add(4242);
    launchWorks = false;
    const svc = service();
    const result = await svc.connect();
    expect(result.ok).toBe(false);
    expect(terminated).toContain(4242);
    expect(launched.length).toBe(1);
  });

  it("ignores a dead recorded pid and simply starts anew", async () => {
    writeFileSync(join(dir, "openconnector-process.json"), JSON.stringify({ pid: 4242, command: "openconnector", url: "http://127.0.0.1:3000/mcp", startedAt: 1 }), { mode: 0o600 });
    const svc = service();
    expect((await svc.connect()).ok).toBe(true);
    expect(launched.length).toBe(1);
    expect(terminated).not.toContain(4242);
  });
});

describe("disconnect", () => {
  it("stops the managed process, drops the entry and clears the record", async () => {
    const svc = service();
    expect((await svc.connect()).ok).toBe(true);
    const pid = svc.status().pid;
    const result = await svc.disconnect();
    expect(result.ok).toBe(true);
    expect(terminated).toContain(pid);
    expect(cfg.mcpServers?.[OPENCONNECTOR_SERVER]).toBeUndefined();
    expect(() => readFileSync(join(dir, "openconnector-process.json"))).toThrow();
    expect(forgotten).toContain(OPENCONNECTOR_SERVER);
    expect(svc.status().state).toBe("not-connected");
  });
});

describe("configCheck / configSaved", () => {
  it("rejects a bad address before it is saved", async () => {
    const svc = service();
    const refusal = await svc.configCheck({ openconnector: { url: "http://203.0.113.9:3000/mcp" } });
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("address");
    const managedRemote = await svc.configCheck({ openconnector: { url: "https://remote.example/mcp" } });
    expect(managedRemote?.code).toBe("address");
    expect(await svc.configCheck({ openconnector: { url: "http://localhost:3000/mcp", args: ["--port", "3000"] } })).toBeNull();
  });

  it("a changed command stops the managed process and the next check starts the new one", async () => {
    const svc = service();
    expect((await svc.connect()).ok).toBe(true);
    const firstPid = svc.status().pid;
    expect(launched.length).toBe(1);
    cfg = { ...cfg, openconnector: { ...cfg.openconnector, command: "openconnector-v2" } };
    svc.configSaved({ openconnector: { command: "openconnector-v2" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminated).toContain(firstPid);
    expect(launched.length).toBe(2);
    expect(launched[1].command).toBe("openconnector-v2");
    expect(svc.status().state).toBe("connected");
  });

  it("loopback=false ignores the command: a Cloud never manages the process", async () => {
    cfg = { ...cfg, openconnector: { url: "https://connector.example.com/mcp", command: "openconnector" } };
    const svc = service({ loopback: false });
    expect(svc.status().managed).toBe(false);
  });
});
