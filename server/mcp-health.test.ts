import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
