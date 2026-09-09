import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let fixtureHome = "";
let base = "";
let stateFile = "";
let dumpFile = "";
let finishFile = "";
let stderr = "";
const vmState = (state: Record<string, unknown> = {}) => writeFileAtomic(stateFile, JSON.stringify(state));
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(r => setTimeout(r, 40));
  }
}
const dump = () => until(() => existsSync(dumpFile) ? JSON.parse(readFileSync(dumpFile, "utf8")) : null, Boolean);
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => !s.bots.find((b: any) => b.id === botId)?.busy);
const computer = (d: any) => d.mcpConfig.mcpServers.computer;
const gate = (c: any) => fetch(c.env.OMB_CONTROL_URL, { headers: { authorization: `Bearer ${c.env.OMB_CONTROL_TOKEN}` } });

beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "omb-group-vm-"));
  stateFile = join(fixtureHome, "vm.json");
  dumpFile = join(fixtureHome, "dump.json");
  finishFile = join(fixtureHome, "finish");
  vmState();
  const data = join(fixtureHome, "data");
  const ui = join(fixtureHome, "static");
  mkdirSync(data); mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>Isolated VM routing</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
    driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
    environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
  } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: {
      PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_DATA_DIR: data,
      APPDATA: join(fixtureHome, "appdata"), LOCALAPPDATA: join(fixtureHome, "localappdata"),
      TEMP: fixtureHome, TMP: fixtureHome, TMPDIR: fixtureHome,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", c => { stderr += c; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
});
afterAll(async () => {
  if (stateFile) vmState();
  if (finishFile) writeFileSync(finishFile, "finish");
  await waitForExit(child, { signal: "SIGTERM" });
  if (fixtureHome) await removeTempDir(fixtureHome);
});
const rooms: string[] = [];
afterEach(async () => {
  vmState();
  writeFileSync(finishFile, "finish");
  for (const id of rooms.splice(0)) await stop(id);
});
async function room() {
  vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
  const bots = [];
  for (const name of ["VM lead", "VM worker"]) {
    const { bot } = await api("POST", "/api/bots", { name });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    bots.push(bot);
  }
  const { group } = await api("POST", "/api/groups", { name: "Fixture VM room", memberIds: bots.map(b => b.id),
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bots[0].id } } });
  rooms.push(group.id);
  return { bots, group };
}
const send = (id: string) => api("POST", `/api/groups/${id}/messages`, { text: "Reply once." });
const stop = (id: string) => api("POST", `/api/groups/${id}/interrupt`, {});

describe("Group Local VM ownership on the real isolated server", () => {
  it("releases a failed readiness claim so the bot and room can run again", async () => {
    const { bots, group } = await room();
    vmState({ failed: true });
    await send(group.id);
    await until(() => api("GET", "/api/bots?messages=30"), r => JSON.stringify(r).includes("fixture desktop unavailable"));
    await idle(bots[0].id);
    vmState();
    await send(group.id);
    const c = computer(await dump());
    expect((await gate(c)).status).toBe(200);
    await stop(group.id); await idle(bots[0].id);
  });
  it("does not dispatch after Stop during readiness and releases the old lease", async () => {
    const { bots, group } = await room();
    vmState({ blocked: true }); rmSync(stateFile + ".entered", { force: true });
    await send(group.id);
    await until(() => existsSync(stateFile + ".entered"), Boolean);
    await stop(group.id);
    vmState();
    await idle(bots[0].id);
    expect(existsSync(dumpFile)).toBe(false);
    await send(group.id);
    expect(computer(await dump())).toBeTruthy();
    await stop(group.id); await idle(bots[0].id);
  });
  it("revokes the previous member and rejects cross-bot control after a shared desktop handoff", async () => {
    const { bots, group } = await room();
    await send(group.id);
    const first = computer(await dump());
    expect((await gate(first)).status).toBe(200);
    writeFileSync(finishFile, "finish"); await idle(bots[0].id);
    expect((await gate(first)).status).toBe(401);
    rmSync(finishFile, { force: true }); rmSync(dumpFile, { force: true });
    await api("PATCH", `/api/groups/${group.id}`, { defaultResponder: { kind: "member", botId: bots[1].id } });
    await send(group.id);
    const second = computer(await dump());
    expect(second.args).toEqual(first.args);
    expect((await gate(second)).status).toBe(200);
    expect((await gate(first)).status).toBe(401);
    const impersonation = await fetch(second.env.OMB_CONTROL_URL.replace(bots[1].id, bots[0].id), {
      headers: { authorization: `Bearer ${second.env.OMB_CONTROL_TOKEN}` },
    });
    expect(impersonation.status).toBe(403);
    await stop(group.id); await idle(bots[1].id);
  });
  it("denies computer access when an otherwise active speaker's lease expires", async () => {
    const { bots, group } = await room();
    await send(group.id);
    const c = computer(await dump());
    expect((await gate(c)).status).toBe(200);
    vmState({ clockOffset: 31 * 60_000 });
    expect((await gate(c)).status).toBe(401);
    await stop(group.id); await idle(bots[0].id); vmState();
  });
  it.each(["timeout", "stall"])("releases %s bookkeeping after the interrupt grace period", async (failure) => {
    const { bots, group } = await room();
    vmState({ timeout: failure === "timeout" });
    await send(group.id);
    const c = computer(await dump());
    if (failure === "stall") vmState({ stall: true });
    await idle(bots[0].id);
    expect((await gate(c)).status).toBe(401);
    // Mode changes reject stale localVmActiveThreads even after the bot is idle.
    await api("PATCH", "/api/config", { localVm: { mode: "per-bot", maxInstances: 2 } });
    vmState({ noContainers: true });
    await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
    vmState();
  });
});
