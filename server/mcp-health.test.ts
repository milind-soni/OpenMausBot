import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StdioMcpSpec } from "./contracts.ts";
import { RECHECK_FAILED_MS, createMcpHealth, offNotice, type McpHealthDeps } from "./mcp-health.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const IRIS = { id: "iris", name: "Iris" }, PAUL = { id: "paul", name: "Paul" };
const blender: StdioMcpSpec & { bot?: string } = { command: "/usr/bin/python3", args: ["/data/workspaces/iris/tools/blender-mcp/server.py"], env: {}, bot: "iris" };
const notes: StdioMcpSpec = { command: "npx", args: ["-y", "@x/notes-mcp"], env: {} };

function fixture(options: { startsFor?: (name: string, botId: string) => boolean; servers?: Record<string, StdioMcpSpec & { bot?: string }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-mcp-health-"));
  dirs.push(dir);
  let now = 1_000_000;
  const starts: string[] = [];
  const told: Array<{ text: string; about: string }> = [];
  const servers: Record<string, StdioMcpSpec & { bot?: string }> = options.servers ?? { blender, notes };
  const deps: McpHealthDeps = {
    file: join(dir, "mcp-health.json"),
    servers: () => servers,
    users: (name) => (servers[name]?.bot ? [IRIS] : [IRIS, PAUL]),
    start: async (name, _server, botId) => {
      starts.push(`${name}:${botId}`);
      return (options.startsFor ?? (() => true))(name, botId) ? { ok: true } : { ok: false, error: "The server stopped before the MCP handshake finished." };
    },
    tell: (text, about) => told.push({ text, about: about.id }),
    now: () => now,
  };
  return { deps, health: createMcpHealth(deps), starts, told, tick: (ms: number) => { now += ms; }, servers };
}

describe("checking that command servers start", () => {
  it("checks a server every bot uses once for all of them, and a bot's own for that bot, once each", async () => {
    const { health, starts } = fixture();
    await health.prepare("paul", ["notes"]);
    await health.prepare("iris", ["notes", "blender"]);
    await health.prepare("iris", ["notes", "blender"]);
    expect(starts).toEqual(["notes:paul", "blender:iris"]);
  });

  it("leaves a server that does not start out of every turn that would start it, and says so once", async () => {
    const { health, told, deps } = fixture({ startsFor: (name) => name !== "notes" });
    health.checkAll();
    await health.settled();
    expect(Object.keys(health.usable("paul", { blender, notes }))).toEqual(["blender"]);
    expect(Object.keys(health.usable("iris", { blender, notes }))).toEqual(["blender"]);
    expect(health.off("paul", ["notes"])).toEqual([{ name: "notes", error: "The server stopped before the MCP handshake finished." }]);
    expect(health.offFor("notes")).toEqual(["iris", "paul"]);
    expect(told).toEqual([{ text: "The Notes tool doesn't start, so it's off for now. It comes back on its own once it starts.", about: "iris" }]);
    health.engineFailed("paul", ["notes"]);
    await health.settled();
    const again = createMcpHealth({ ...deps });
    expect(again.usable("paul", { notes }), "kept across a restart").toEqual({});
    again.engineFailed("iris", ["notes"]);
    await again.settled();
    expect(told, "not again for the same server, nor after a restart").toHaveLength(1);
    expect(JSON.parse(readFileSync(deps.file, "utf8")).notes.told).toBeTruthy();
  });

  it("names the bot whose own server does not start", async () => {
    const { health, told } = fixture({ startsFor: (name) => name !== "blender" });
    await health.prepare("iris", ["blender"]);
    expect(told).toEqual([{ text: "Iris's Blender tool doesn't start, so it's off for now. It comes back on its own once it starts.", about: "iris" }]);
    expect(offNotice("blender", null)).toBe("The Blender tool doesn't start, so it's off for now. It comes back on its own once it starts.");
  });

  it("tries a server that did not start again on its own, and again at once when a bot's AI says it failed", async () => {
    let fixed = false;
    const { health, starts, tick } = fixture({ startsFor: (name) => name !== "notes" || fixed });
    await health.prepare("paul", ["notes"]);
    tick(RECHECK_FAILED_MS - 1);
    await health.prepare("paul", ["notes"]);
    expect(starts).toEqual(["notes:paul"]);
    fixed = true;
    tick(1);
    await health.prepare("paul", ["notes"]);
    expect(health.usable("paul", { notes }), "the turn that starts the check again does not wait for it").toEqual({});
    await health.settled();
    expect(Object.keys(health.usable("paul", { notes }))).toEqual(["notes"]);
    fixed = false;
    health.engineFailed("paul", ["notes"]);
    await health.settled();
    expect(starts).toEqual(["notes:paul", "notes:paul", "notes:paul"]);
    expect(health.usable("iris", { notes })).toEqual({});
  });

  it("checks a server afresh once its command line changes", async () => {
    const servers: Record<string, StdioMcpSpec> = { notes };
    const { health, starts } = fixture({ servers });
    await health.prepare("paul", ["notes"]);
    servers.notes = { ...notes, args: ["-y", "@x/notes-mcp@2"] };
    expect(health.usable("paul", servers), "an edited server is not judged by the old check").toEqual(servers);
    await health.prepare("paul", ["notes"]);
    expect(starts).toEqual(["notes:paul", "notes:paul"]);
  });

  it("checks an edited server while its previous check is still pending", async () => {
    const { deps, servers, told } = fixture({ servers: { notes } });
    let finishOld!: (value: { ok: false; error: string }) => void;
    const started: StdioMcpSpec[] = [];
    const health = createMcpHealth({ ...deps, start: async (_name, server) => {
      started.push(server);
      return started.length === 1
        ? new Promise<{ ok: false; error: string }>((resolve) => { finishOld = resolve; })
        : { ok: true };
    } });
    const old = health.prepare("iris", ["notes"]);
    servers.notes = { ...notes, args: ["-y", "@x/notes-mcp@2"] };
    health.changed("notes");
    const current = health.prepare("iris", ["notes"]);
    expect(started).toHaveLength(2);
    await current;
    finishOld({ ok: false, error: "the old command failed" });
    await old;
    await health.settled();
    expect(health.usable("iris", servers)).toEqual(servers);
    expect(health.off("iris", ["notes"])).toEqual([]);
    expect(told).toEqual([]);
    const restarted = createMcpHealth(deps);
    expect(restarted.usable("iris", servers)).toEqual(servers);
    expect(JSON.parse(readFileSync(deps.file, "utf8")).notes.checks["*"].ok).toBe(true);
  });

  it("restarts a pending check even when the command specification is unchanged", async () => {
    const { deps, told } = fixture({ servers: { notes } });
    let finishOld!: (value: { ok: false; error: string }) => void;
    let calls = 0;
    const health = createMcpHealth({ ...deps, start: async () => ++calls === 1
      ? new Promise<{ ok: false; error: string }>((resolve) => { finishOld = resolve; })
      : { ok: true } });
    const old = health.prepare("iris", ["notes"]);
    health.changed("notes");
    const current = health.prepare("iris", ["notes"]);
    expect(calls).toBe(2);
    await current;
    finishOld({ ok: false, error: "the replaced process failed" });
    await old;
    await health.settled();
    expect(health.usable("iris", { notes })).toEqual({ notes });
    expect(told).toEqual([]);
  });

  it("does not stamp a pending result with a script's later file identity", async () => {
    const { deps, servers, told } = fixture({ servers: {} });
    const script = join(deps.file, "..", "server.mjs");
    writeFileSync(script, "old");
    servers.notes = { command: process.execPath, args: [script], env: {} };
    let finishOld!: (value: { ok: false; error: string }) => void;
    let calls = 0;
    const health = createMcpHealth({ ...deps, start: async () => ++calls === 1
      ? new Promise<{ ok: false; error: string }>((resolve) => { finishOld = resolve; })
      : { ok: true } });
    const old = health.prepare("iris", ["notes"]);
    writeFileSync(script, "new script content");
    finishOld({ ok: false, error: "old script failed" });
    await old;
    expect(health.off("iris", ["notes"])).toEqual([]);
    expect(told).toEqual([]);
    await health.prepare("iris", ["notes"]);
    expect(calls).toBe(2);
    expect(health.usable("iris", servers)).toEqual(servers);
  });

  it("keeps a replacement's failure when the obsolete check later succeeds", async () => {
    const { deps, servers, told } = fixture({ servers: { notes } });
    let finishOld!: (value: { ok: true }) => void;
    let calls = 0;
    const health = createMcpHealth({ ...deps, start: async () => ++calls === 1
      ? new Promise<{ ok: true }>((resolve) => { finishOld = resolve; })
      : { ok: false, error: "replacement cannot start" } });
    const old = health.prepare("iris", ["notes"]);
    servers.notes = { ...notes, args: ["replacement"] };
    await health.prepare("iris", ["notes"]);
    finishOld({ ok: true });
    await old;
    expect(health.usable("iris", servers)).toEqual({});
    expect(health.off("iris", ["notes"])).toEqual([{ name: "notes", error: "replacement cannot start" }]);
    expect(told).toHaveLength(1);
  });

  it("discards a removed server's pending failure without saving or notifying", async () => {
    const { deps, servers, told } = fixture({ servers: { notes } });
    let finish!: (value: { ok: false; error: string }) => void;
    const health = createMcpHealth({ ...deps, start: async () => new Promise<{ ok: false; error: string }>((resolve) => { finish = resolve; }) });
    const pending = health.prepare("iris", ["notes"]);
    delete servers.notes;
    health.changed("notes");
    finish({ ok: false, error: "removed server failed" });
    await pending;
    expect(JSON.parse(readFileSync(deps.file, "utf8"))).toEqual({});
    expect(told).toEqual([]);
  });
});
