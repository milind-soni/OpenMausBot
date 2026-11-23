// Every export of the provider, VPS and Local VM modules, and every way to start a process, is a counting stand-in here:
// the only calls this route may make are the reads of what the server already holds.
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotComputersPayload } from "../../shared/bot-computers.ts";
import * as boat from "../boat.ts";
import { boatHealth } from "../boat-health.ts";
import { teamRoleScopes, type TeamRole } from "../cloud-team.ts";
import { createComputerFrames } from "../computer-frames.ts";
import * as container from "../container-computer.ts";
import { requiredScope, resolveRequestAuth, type RequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { resolveSurface } from "../surface.ts";
import type { BotRecord, TaskRecord } from "../store.ts";
import { teamComputerOwner } from "../team-computers.ts";
import * as vps from "../vps-computer.ts";
import { BOT_COMPUTERS_PATH, botComputerRows, createBotComputersRoute, type BotComputersHost, type BotComputersRouteDeps } from "./bot-computers.ts";
import { createComputerRoutes, type ComputerRouteDeps } from "./computers.ts";
import { PASS, type RouteContext } from "./table.ts";

const seams = vi.hoisted(() => {
  const calls: string[] = [];
  const reads = new Set(["boat.boatIdOf", "boat.deadBoatOf", "vps.lastVpsStatus", "vps.vpsContainerName", "container.lastLocalVmStatus"]);
  const isClass = (fn: unknown) => typeof fn === "function" && /^class\b/.test(Function.prototype.toString.call(fn));
  const counted = (name: string, mod: Record<string, unknown>, allowed: (key: string) => boolean) => Object.fromEntries(Object.entries(mod).map(([key, value]) => {
    if (typeof value !== "function" || isClass(value)) return [key, value];
    return [key, vi.fn((...args: unknown[]) => {
      calls.push(`${name}.${key}`);
      if (!allowed(`${name}.${key}`)) throw new Error(`${name}.${key} looks at a computer`);
      return (value as (...a: unknown[]) => unknown)(...args);
    })];
  }));
  return { calls, reads, counted };
});

vi.mock("../boat.ts", async (actual) => seams.counted("boat", await actual(), (key) => seams.reads.has(key)));
vi.mock("../vps-computer.ts", async (actual) => seams.counted("vps", await actual(), (key) => seams.reads.has(key)));
vi.mock("../container-computer.ts", async (actual) => seams.counted("container", await actual(), (key) => seams.reads.has(key)));
vi.mock("node:child_process", async (actual) => {
  const real = await actual<typeof import("node:child_process")>();
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
  return { ...real, default: { ...real, ...seams.counted("child_process", Object.fromEntries(names.map((n) => [n, real[n]])), () => false) },
    ...seams.counted("child_process", Object.fromEntries(names.map((n) => [n, real[n]])), () => false) };
});

const fetchCalls = vi.fn(async () => { throw new Error("fetch looks at a computer"); });
beforeEach(() => { seams.calls.length = 0; fetchCalls.mockClear(); vi.stubGlobal("fetch", fetchCalls); });
afterEach(() => { vi.unstubAllGlobals(); boatHealth.clear(); vi.mocked(boat.boatIdOf).mockReset(); vi.mocked(vps.lastVpsStatus).mockReset(); vi.mocked(container.lastLocalVmStatus).mockReset(); });

const TEAM = { id: "11111111-1111-4111-8111-111111111111", name: "Design desktop", section: "Design" };
const SEEN_VM = "bot:seen";

const bot = (id: string, fields: Partial<BotRecord> = {}, tasks: Partial<TaskRecord>[] = []): BotRecord =>
  ({ id, name: id, threadId: `${id}-main`, tasks: tasks.map((task, i) => ({ threadId: `${id}-t${i}`, ...task })), ...fields }) as unknown as BotRecord;

/** turnSurfacePlan's answer: a chat's pin, else Works on; a team bot always the cloud, as index.ts forces it. */
const surfacePlan: BotComputersHost["surfacePlan"] = (b, threadId) => {
  const team = b.section === "Design" && b.computer === undefined;
  const task = team || !threadId ? undefined : b.tasks?.find((one) => one.threadId === threadId);
  return resolveSurface({ destination: team ? "cloud" : b.computer, pinnedSurface: task?.surface, browserOn: b.browser !== false });
};

function fixture(bots: BotRecord[], over: Partial<BotComputersHost> = {}) {
  const host: BotComputersHost = {
    surfacePlan, visibleFor: () => ({ bot: () => true, thread: () => true }),
    engineCapabilities: () => ({ computerMcp: true, localComputerMcp: true }), cloudHome: false, thisComputerConnected: () => true, ...over,
  };
  const frames = createComputerFrames({
    listMachines: vi.fn(async () => { throw new Error("listing looks at the provider"); }),
    capture: vi.fn(async () => { throw new Error("capture looks at a screen"); }),
    turnFrame: () => undefined, working: () => false, held: () => false, tickMs: 1e9,
  });
  const deps: BotComputersRouteDeps = {
    cfg: { vps: { sshAlias: "hetz" }, vpsServers: [{ name: "Big box", sshAlias: "hetz" }], computerName: "Studio Mac" } as BotComputersRouteDeps["cfg"],
    store: { bots, tasks: (id: string) => bots.find((b) => b.id === id)?.tasks ?? [] },
    teamComputers: { forBot: (b) => (b.section === "Design" && b.computer === undefined && b.cloudBackend !== "vps" ? { ...TEAM, createdAt: 0, requestId: "r" } as never : undefined) },
    frames, localVmSeen: new Set([SEEN_VM]), localVmActiveThreads: new Map(),
    localVmTargetForStatus: (botId, threadId) => ({ key: threadId === "pool-t0" ? "pool:2" : botId === "seen" ? SEEN_VM : "shared", containerName: "c", workspaceDir: "/w", viewerPort: null, label: "l" }),
    botComputers: host, now: () => 1_000, platform: "darwin",
  };
  return { deps, frames };
}

const call = async (handler: ReturnType<typeof createBotComputersRoute>, auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] }) => {
  const sent: Array<{ status: number; body: BotComputersPayload }> = [];
  const out = await handler({
    req: { headers: {} } as IncomingMessage, res: { setHeader: () => {} } as unknown as ServerResponse,
    url: new URL(`http://127.0.0.1${BOT_COMPUTERS_PATH}`), path: BOT_COMPUTERS_PATH, method: "GET", auth,
    json: ((_res: ServerResponse, status: number, body: BotComputersPayload) => { sent.push({ status, body }); }) as RouteContext["json"],
    readBody: (async () => ({})) as RouteContext["readBody"],
  });
  return { out, sent };
};

const everyKind = () => [
  bot("own", { computer: "cloud" }),
  bot("ted", { section: "Design" }, [{ surface: "vm" }]),
  bot("vee", { computer: "cloud", cloudBackend: "vps" }),
  bot("vm", { computer: "vm" }, [{ surface: "local" }, { surface: "local", archivedAt: 5 }]),
  bot("loc", { computer: "local" }),
  bot("web", { computer: "browser" }),
  bot("nil", { computer: "off" }),
  bot("auto"),
  bot("seen"),
  bot("gone", { computer: "cloud", hidden: true }),
];

describe("GET /api/computers/bots", () => {
  it("reads only what the server holds: no provider, VPS, Docker, SSH, process or screen call", async () => {
    const { deps } = fixture(everyKind());
    // The real wiring, with the map's own frames cache: every other dependency records the call and refuses it.
    const asked: string[] = [];
    const real = { ...deps, computerControl: { snapshot: () => ({ held: false }) }, managedBoatOwners: () => [], computerProviderConfigTransitions: new Set(),
      teamComputers: { ...deps.teamComputers, list: () => [TEAM] }, botHasActiveTurn: () => false, teamComputerInUse: () => false };
    const handler = createComputerRoutes(new Proxy(real, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : (...args: unknown[]) => { asked.push(String(key)); throw new Error(`${String(key)}(${args.length})`); }),
    }) as unknown as ComputerRouteDeps);
    asked.length = 0;
    seams.calls.length = 0;
    const { out, sent } = await call(handler);
    expect(out).not.toBe(PASS);
    expect(sent[0]!.status).toBe(200);
    expect(sent[0]!.body.rows.length).toBeGreaterThan(8);
    expect(seams.calls.filter((name) => !seams.reads.has(name))).toEqual([]);
    expect(fetchCalls).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("names each bot's computer, a chat with its own place, and Auto only where it needs no look", async () => {
    const { deps } = fixture(everyKind());
    boatHealth.answered("box_own");
    vi.mocked(boat.boatIdOf).mockImplementation((owner) => (owner === "own" ? "box_own" : null));
    vi.mocked(vps.lastVpsStatus).mockImplementation(() => ({ status: { daemonUp: true, container: "stopped", desktopReady: false, ready: false } as never, at: 700 }));
    const { sent } = await call(createBotComputersRoute(deps));
    const rows = sent[0]!.body.rows;
    expect(sent[0]!.body.now).toBe(1_000);
    const by = (botId: string, threadId?: string) => rows.find((row) => row.botId === botId && row.threadId === threadId);
    expect(by("own")).toMatchObject({ kind: "cloud", computerId: "cloud:own", boxId: "box_own", state: "ready", name: null });
    expect(by("ted")).toMatchObject({ kind: "cloud", computerId: `cloud:${teamComputerOwner(TEAM.id)}`, teamComputerId: TEAM.id, name: "Design desktop", state: "unknown", stateAt: null });
    expect(by("ted", "ted-t0")).toBeUndefined();
    expect(by("vee")).toEqual({ botId: "vee", kind: "vps", computerId: `vps:hetz/${vps.vpsContainerName("vee")}`, name: "Big box", state: "asleep", stateAt: 700,
      vps: { serverId: "vps:hetz", alias: "hetz", container: vps.vpsContainerName("vee") } });
    expect(by("vm")).toMatchObject({ kind: "vm", computerId: "vm:shared", state: "unknown" });
    expect(by("vm", "vm-t0")).toMatchObject({ kind: "local", computerId: "local", name: "Studio Mac", state: "ready", stateAt: 1_000 });
    expect(by("vm", "vm-t1")).toBeUndefined();
    expect(by("loc")).toMatchObject({ kind: "local", computerId: "local" });
    expect(by("web")).toMatchObject({ kind: "browser", computerId: null, state: "unknown" });
    expect(by("nil")).toMatchObject({ kind: "off", computerId: null, state: "none" });
    expect(by("auto")).toMatchObject({ kind: "auto", autoKind: "local", computerId: "local" });
    expect(by("seen")).toEqual({ botId: "seen", kind: "auto", computerId: null, name: null, state: "unknown", stateAt: null });
    expect(by("gone")).toBeUndefined();
  });

  it("resolves Auto to the VPS or the browser when nothing else could be picked, and keeps a pool seat per chat", async () => {
    const bots = [bot("vee", { cloudBackend: "vps" }), bot("web"), bot("pool", { computer: "vm" }, [{ threadId: "pool-t0" } as Partial<TaskRecord>])];
    const { deps } = fixture(bots, { thisComputerConnected: () => false });
    vi.mocked(container.lastLocalVmStatus).mockImplementation((target) => (target.key === "pool:2" ? { status: { daemonUp: true, container: "running", desktopReady: true, ready: true } as never, at: 900 } : null));
    const rows = botComputerRows(deps, { bot: () => true, thread: () => true });
    expect(rows.find((row) => row.botId === "vee")).toMatchObject({ kind: "auto", autoKind: "vps", vps: { alias: "hetz" }, state: "unknown" });
    expect(rows.find((row) => row.botId === "web")).toMatchObject({ kind: "auto", autoKind: "browser" });
    expect(rows.find((row) => row.threadId === "pool-t0")).toMatchObject({ kind: "vm", computerId: "vm:pool:2", state: "ready", stateAt: 900 });
    expect(botComputerRows(fixture(bots, { cloudHome: true }).deps, { bot: () => true, thread: () => true })
      .find((row) => row.botId === "web")).toMatchObject({ autoKind: "browser" });
  });

  it("reads a cloud desktop from the map's last listing, and one that stopped answering as unreachable", async () => {
    const { deps, frames } = fixture([bot("own", { computer: "cloud" }), bot("new", { computer: "cloud" })]);
    const listed = createComputerFrames({
      listMachines: async () => [{ owner: "own", boxId: "box_own", state: "archived" }],
      capture: async () => ({ data: "", mime: "image/jpeg" }), turnFrame: () => undefined, working: () => false, held: () => false, tickMs: 1e9,
    });
    await listed.refresh();
    const rows = botComputerRows({ ...deps, frames: listed }, { bot: () => true, thread: () => true });
    expect(rows[0]).toMatchObject({ computerId: "cloud:own", boxId: "box_own", state: "asleep" });
    expect(rows[1]).toMatchObject({ computerId: "cloud:new", state: "none" });
    expect(rows[1]!.stateAt).toBe(listed.listedAt());
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const at of [10_000, 40_000, 71_000]) { vi.setSystemTime(at); boatHealth.unanswered("box_own"); }
    } finally { vi.useRealTimers(); }
    expect(botComputerRows({ ...deps, frames: listed }, { bot: () => true, thread: () => true })[0]).toMatchObject({ state: "unreachable", stateAt: 10_000 });
    expect(frames.watching()).toBe(false);
  });

  it("shows a person only the bots and chats they can see", async () => {
    const bots = [bot("mine", { computer: "vm" }, [{ surface: "local" }]), bot("theirs", { computer: "cloud" })];
    const { deps } = fixture(bots, { visibleFor: (auth) => ({ bot: (id) => auth.kind === "loopback" || id === "mine", thread: () => auth.kind === "loopback" }) });
    const member = { kind: "session", scopes: ["admin", "client"], via: "bearer", session: { id: "s" } } as unknown as RequestAuth;
    const { sent } = await call(createBotComputersRoute(deps), member);
    expect(sent[0]!.body.rows).toEqual([expect.objectContaining({ botId: "mine", kind: "vm" })]);
    expect((await call(createBotComputersRoute(deps))).sent[0]!.body.rows.map((row) => row.threadId ?? row.botId)).toEqual(["mine", "mine-t0", "theirs"]);
  });
});

describe("who may read it", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-bot-computers-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is an admin's, like every computer route: a member's or a chat-only session is refused at the gate", () => {
    expect(requiredScope("GET", BOT_COMPUTERS_PATH)).toBe("admin");
    expect(requiredScope("GET", BOT_COMPUTERS_PATH, { sharedComputers: true })).toBe("admin");
    const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
    const ask = (token: string) => resolveRequestAuth({ method: "GET", headers: { host: "127.0.0.1:1", authorization: `Bearer ${token}` }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage,
      { sessions, cookieName: "c", streamPath: "/api/events", url: new URL(`http://127.0.0.1:1${BOT_COMPUTERS_PATH}`) });
    const teamSession = (role: TeamRole) => {
      const opened = sessions.openPairing({ scopes: teamRoleScopes(role), member: { email: `${role}@acme.test`, role }, memberCheckedAt: Date.now() });
      const paired = sessions.exchange({ code: opened.code, label: "Device", source: "203.0.113.9" });
      if (!paired.ok) throw new Error(paired.error);
      return paired.token;
    };
    const chatOnly = sessions.issue({ label: "Phone", scopes: ["client"] }).token;
    expect(sessions.hasChatOnlyAccess()).toBe(true);
    expect(ask(teamSession("member"))).toMatchObject({ auth: null, status: 403 });
    expect(ask(chatOnly)).toMatchObject({ auth: null, status: 403 });
    expect(ask(teamSession("admin")).auth).toMatchObject({ kind: "session" });
    expect(ask(sessions.issue({ label: "Mac", scopes: ["admin", "client"] }).token).auth).toMatchObject({ kind: "session" });
  });
});

describe("cost", () => {
  it("answers for 200 bots well inside a 5 s poll", async () => {
    const bots = Array.from({ length: 200 }, (_, i) => bot(`b${i}`, [{ computer: "cloud" }, { section: "Design" }, { computer: "cloud", cloudBackend: "vps" }, { computer: "vm" }, {}][i % 5] as Partial<BotRecord>,
      Array.from({ length: 30 }, (_, t) => (t % 6 === 0 ? { surface: "local" as const } : {}))));
    const { deps } = fixture(bots);
    const handler = createBotComputersRoute(deps);
    await call(handler);
    const runs = 50;
    const started = performance.now();
    let bytes = 0;
    for (let i = 0; i < runs; i++) bytes = JSON.stringify((await call(handler)).sent[0]!.body).length;
    const perCall = (performance.now() - started) / runs;
    console.info(`GET ${BOT_COMPUTERS_PATH}: 200 bots, 6,000 chats: ${perCall.toFixed(2)} ms a call, ${bytes} bytes`);
    expect(perCall).toBeLessThan(50);
  });
});
