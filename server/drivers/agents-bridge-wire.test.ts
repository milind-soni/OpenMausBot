// What the agents proxy puts on the wire for `tools/list` with the tool
// bridge on (OMB_AGENTS_TOOL_BRIDGE=1, agents-bridge.ts), pinned byte for
// byte and measured, the way agents-catalog-wire.test.ts pins the whole
// catalog. That file and its goldens are not this one's to change: with the
// switch off the proxy serves them to the byte, which it keeps checking and
// one test below says outright.
//
// Every profile pinned there has a bridged twin here, with the same switches
// and under the same name, so the two manifests read side by side:
//   agents-catalog-goldens/profiles.json          the turn's whole catalog
//   agents-catalog-goldens/bridged.profiles.json  what it is listed bridged
// and bridged.tools-list.json is the fullest bridged list, whole.
//
// A bridged list changes whenever the catalog does: a hot tool's bytes are
// its own, and find_tool's description names every hidden tool. So after a
// catalog change run both files once with UPDATE_AGENTS_CATALOG_GOLDENS=1,
// review the golden diff, and move BUDGET_BASELINE by hand.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForExit } from "../testing/cleanup.ts";
import { FIND_TOOL, USE_TOOL, createToolBridge, type BridgeTool } from "./agents-bridge.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_SOURCE = join(HERE, "agents-proxy.ts");
const GOLDENS = join(HERE, "agents-catalog-goldens");
const UPDATE = process.env.UPDATE_AGENTS_CATALOG_GOLDENS === "1";
const BRIDGE_ON = { OMB_AGENTS_TOOL_BRIDGE: "1" };

const flag = (on: boolean) => (on ? "1" : "0");

/** The switch combinations agents-catalog-wire.test.ts pins, under the names
 * it gives them. The first test below holds this to that file's manifest, so
 * a profile added there cannot go without a bridged twin here. */
function profiles(): Record<string, Record<string, string>> {
  const all: Record<string, Record<string, string>> = {};
  for (const chief of [true, false]) {
    for (const skills of [false, true]) {
      for (const shared of [false, true]) {
        for (const voice of [false, true]) {
          const name = [skills && "skills", shared && "shared", voice && "voice", !chief && "non-chief"]
            .filter(Boolean).join("+") || "default";
          all[name] = {
            OMB_SKILL_AUTHORING_ENABLED: flag(skills),
            OMB_SHARED_COMPUTERS_ENABLED: flag(shared),
            OMB_VOICE_NOTES: flag(voice),
            OMB_CHIEF_OF_STAFF: flag(chief),
          };
        }
      }
    }
  }
  for (const name of ["skills+shared+voice", "skills+shared+voice+non-chief"]) {
    all[`${name}+cloud-home`] = { ...all[name]!, OMB_CLOUD_HOME: "1" };
  }
  all["skills+shared+voice+escalations"] = { ...all["skills+shared+voice"]!, OMB_ESCALATIONS: "1" };
  all["skills+shared+voice+escalations+x"] = { ...all["skills+shared+voice+escalations"]!, OMB_X_RESEARCH: "1" };
  all["default+legacy-switches"] = { ...all.default!, OMB_ROOM_TURN: "1", OMB_OWN_THREAD_CREATION: "1", OMB_EXTERNAL_RUNTIME: "1" };
  return all;
}

const PROFILES = profiles();
/** Refused by the server to every bot that is not a Chief of Staff. */
const CHIEF_ONLY_TOOLS = ["create_bot", "list_team_setup", "list_team_library", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread", "cancel_job"];
/** The profile that mounts the most: its bridged list is checked in whole. */
const FULL = "skills+shared+voice+escalations+x";

/** Bytes of each bridged list when its budget was last set. A list may not
 * exceed this by more than 2%, and may not undercut it by more than 2%
 * either: lock a saving in by lowering the number. A Chief's list is longer
 * than another bot's only by the Chief-only names in find_tool's description. */
const BUDGET_BASELINE: Record<string, number> = {
  "default": 15996,
  "voice": 16737,
  "shared": 16036,
  "shared+voice": 16777,
  "skills": 16023,
  "skills+voice": 16764,
  "skills+shared": 16063,
  "skills+shared+voice": 16804,
  "non-chief": 15866,
  "voice+non-chief": 16607,
  "shared+non-chief": 15906,
  "shared+voice+non-chief": 16647,
  "skills+non-chief": 15893,
  "skills+voice+non-chief": 16634,
  "skills+shared+non-chief": 15933,
  "skills+shared+voice+non-chief": 16674,
  "skills+shared+voice+cloud-home": 16802,
  "skills+shared+voice+non-chief+cloud-home": 16672,
  "skills+shared+voice+escalations": 16822,
  "skills+shared+voice+escalations+x": 16916,
  "default+legacy-switches": 15996,
};

type RpcAnswer = { id: number; result?: { tools?: unknown[]; content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number; message: string } };

/** One freshly spawned proxy's raw answer lines to `requests`, in the order
 * asked, read off its stdout as they arrive. */
async function proxyLines(entry: string, env: Record<string, string>, requests: Array<{ method: string; params?: unknown }>): Promise<string[]> {
  // A developer shell (or an OpenMausBot turn running this suite) can carry
  // OMB_* switches of its own; the profile must be the only source.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const child = spawn(process.execPath, [entry], {
    env: { ...inherited, OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-golden", OMB_THREAD_ID: "thread-golden", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const lines = new Map<number, string>();
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          lines.set((JSON.parse(line) as RpcAnswer).id, line);
        }
        if (lines.size === requests.length) resolve(requests.map((_, index) => lines.get(index + 1)!));
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`agents proxy exited (${code}) before answering every request`)));
      // stdin stays open until every answer is read: closing it makes the
      // proxy exit, and on Windows a pipe write still in flight is lost with it.
      for (const [index, request] of requests.entries()) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request })}\n`);
    });
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

const RPC_PREFIX = '{"jsonrpc":"2.0","id":1,"result":';

/** The exact `result` text of one tools/list answer from a freshly spawned
 * proxy. Sliced out of the raw stdout line, never re-serialized. */
async function toolsListWire(entry: string, env: Record<string, string>): Promise<string> {
  const [line] = await proxyLines(entry, env, [{ method: "tools/list" }]);
  expect(line!.startsWith(RPC_PREFIX) && line!.endsWith("}")).toBe(true);
  return line!.slice(RPC_PREFIX.length, -1);
}

async function bridgedWireForEveryProfile(entry: string): Promise<Record<string, string>> {
  const names = Object.keys(PROFILES);
  const all = await Promise.all(names.map((name) => toolsListWire(entry, { ...PROFILES[name]!, ...BRIDGE_ON })));
  return Object.fromEntries(names.map((name, index) => [name, all[index]!]));
}

const proxyAnswers = async (entry: string, env: Record<string, string>, requests: Array<{ method: string; params?: unknown }>) =>
  (await proxyLines(entry, env, requests)).map((line) => JSON.parse(line) as RpcAnswer);

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const toolsOf = (wire: string) => (JSON.parse(wire) as { tools: Tool[] }).tools;
/** The turn's whole catalog as the proxy serializes it with the switch off;
 * agents-catalog-wire.test.ts proves these are the proxy's bytes. */
const unbridgedWire = (name: string) => JSON.stringify({ tools: availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", ...PROFILES[name]! })) });

const goldenPath = join(GOLDENS, "bridged.tools-list.json");
const manifestPath = join(GOLDENS, "bridged.profiles.json");
// Stored pretty-printed and compared after JSON.parse, as the unbridged
// goldens are, so a wire change reads as a diff and a CRLF checkout passes.
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
type Manifest = Record<string, { bytes: number; sha256: string; tools: string[] }>;
const manifestOf = (wires: Record<string, string>): Manifest =>
  Object.fromEntries(Object.entries(wires).map(([name, wire]) => [
    name,
    { bytes: bytes(wire), sha256: sha256(wire), tools: toolsOf(wire).map((tool) => tool.name) },
  ]));

/** The names find_tool's description says are reached through use_tool. */
const namedHidden = (wire: string) => {
  const description = toolsOf(wire).find((tool) => tool.name === FIND_TOOL)!.description;
  return description.slice(description.lastIndexOf(": ") + 2).replace(/\.$/, "").split(", ");
};

/** A bridged conversation that needs no harness: a search, a call that is not
 * the shape of one, and a name outside a non-Chief's profile. */
const BRIDGE_REQUESTS = [
  { method: "tools/call", params: { name: FIND_TOOL, arguments: { query: "schedule a recurring task every morning" } } },
  { method: "tools/call", params: { name: USE_TOOL, arguments: { arguments: { thread_id: 7 } } } },
  { method: "tools/call", params: { name: USE_TOOL, arguments: { name: "create_bot", arguments: {} } } },
];

let wires: Record<string, string> = {};

beforeAll(async () => {
  wires = await bridgedWireForEveryProfile(PROXY_SOURCE);
  if (UPDATE) {
    writeJson(goldenPath, JSON.parse(wires[FULL]!));
    writeJson(manifestPath, manifestOf(wires));
  }
}, 120_000);

describe("agents proxy tools/list golden with the tool bridge on", () => {
  it("has a bridged twin for every profile the unbridged goldens pin, of exactly that catalog", () => {
    const unbridged = readJson(join(GOLDENS, "profiles.json")) as Manifest;
    expect(Object.keys(PROFILES)).toEqual(Object.keys(unbridged));
    expect(Object.keys(wires)).toEqual(Object.keys(unbridged));
    for (const [name, pinned] of Object.entries(unbridged)) {
      expect({ bytes: bytes(unbridgedWire(name)), sha256: sha256(unbridgedWire(name)) }, name).toEqual({ bytes: pinned.bytes, sha256: pinned.sha256 });
    }
  });

  it("round-trips through JSON.parse unchanged, so a parsed golden can stand for the bytes", () => {
    for (const wire of Object.values(wires)) expect(JSON.stringify(JSON.parse(wire))).toBe(wire);
  });

  it("the fullest bridged profile is byte-identical to its golden", () => {
    const golden = readJson(goldenPath);
    const wire = wires[FULL]!;
    // Structural first: a readable diff naming the tool and field that moved.
    expect(JSON.parse(wire)).toEqual(golden);
    // Then the bytes: key order and number formatting included.
    expect(wire).toBe(JSON.stringify(golden));
  });

  it("every bridged profile matches its pinned tool names, byte count and sha256", () => {
    expect(manifestOf(wires)).toEqual(readJson(manifestPath));
  });

  it("lists a subset of its twin's tools with their bytes unchanged, then find_tool and use_tool", () => {
    for (const [name, wire] of Object.entries(wires)) {
      const twin = new Map(toolsOf(unbridgedWire(name)).map((tool) => [tool.name, JSON.stringify(tool)]));
      const tools = toolsOf(wire);
      expect(tools.slice(-2).map((tool) => tool.name), name).toEqual([FIND_TOOL, USE_TOOL]);
      const hot = tools.slice(0, -2);
      for (const tool of hot) expect(JSON.stringify(tool), `${name}: ${tool.name}`).toBe(twin.get(tool.name));
      // in the twin's order, and a real saving: fewer than half of its tools
      expect(hot.map((tool) => tool.name), name).toEqual([...twin.keys()].filter((tool) => hot.some((listed) => listed.name === tool)));
      expect(hot.length, name).toBeGreaterThanOrEqual(6);
      expect(hot.length, name).toBeLessThan(twin.size / 2);
      expect(twin.has(FIND_TOOL) || twin.has(USE_TOOL), name).toBe(false);
    }
  });

  it("names every other tool of its twin, and no tool of any other profile, in find_tool's description", () => {
    for (const [name, wire] of Object.entries(wires)) {
      const listed = new Set(toolsOf(wire).map((tool) => tool.name));
      const twinNames = toolsOf(unbridgedWire(name)).map((tool) => tool.name);
      expect(namedHidden(wire), name).toEqual(twinNames.filter((tool) => !listed.has(tool)));
    }
    // So a bot that is not a Chief is not told the Chief-only tools exist.
    const nonChief = Object.keys(PROFILES).filter((name) => PROFILES[name]!.OMB_CHIEF_OF_STAFF === "0");
    expect(nonChief).toHaveLength(9);
    for (const name of nonChief) {
      for (const tool of CHIEF_ONLY_TOOLS) expect(wires[name], `${name}: ${tool}`).not.toContain(tool);
      const chiefTwin = name === "non-chief" ? "default" : name.replace("+non-chief", "");
      expect(namedHidden(wires[chiefTwin]!), name).toEqual(expect.arrayContaining(CHIEF_ONLY_TOOLS));
    }
  });

  it("keeps the same hot tools whatever the role and features, except the ones a profile does not have", () => {
    const hotOf = (name: string) => toolsOf(wires[name]!).slice(0, -2).map((tool) => tool.name);
    const base = hotOf("default");
    expect(base).toEqual(["tool_result_read", "list_room_targets", "coordinate_bots", "list_bots", "list_rooms", "select_computer", "attach_file", "publish_page", "post_to_room", "request_credential", "request_sign_in", "fill_login", "memory_update"]);
    for (const name of Object.keys(PROFILES)) {
      expect(hotOf(name).filter((tool) => tool !== "send_voice_note"), name).toEqual(base);
      expect(hotOf(name).includes("send_voice_note"), name).toBe(PROFILES[name]!.OMB_VOICE_NOTES === "1");
    }
  });

  it("is what the catalog and the bridge compute in-process, so another front end lists the same tools", () => {
    for (const name of Object.keys(PROFILES)) {
      const turn = catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", ...PROFILES[name]! });
      const tools = createToolBridge(availableTools(turn) as BridgeTool[]).listed;
      expect(JSON.stringify({ tools }), name).toBe(wires[name]);
    }
  });

  it("uses no JSON-Schema keyword a provider conversion is known to drop or mangle", () => {
    // The bridge's two schemas carry no branches, and use_tool's arguments is a plain object.
    for (const [name, wire] of Object.entries(wires)) {
      expect(wire.match(/"(\$ref|\$defs|definitions|oneOf|anyOf|allOf)":/g), name).toBeNull();
    }
    const own = new Map(toolsOf(wires[FULL]!).slice(-2).map((tool) => [tool.name, tool.inputSchema as { properties: Record<string, unknown> }]));
    expect(JSON.stringify([...own.values()])).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
    expect(own.get(FIND_TOOL)).toEqual({ type: "object", additionalProperties: false, properties: { query: { type: "string", description: expect.any(String) } }, required: ["query"] });
    expect(own.get(USE_TOOL)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", description: expect.any(String) }, arguments: { type: "object", additionalProperties: true, description: expect.any(String) } },
      required: ["name"],
    });
  });

  it("serves the unbridged goldens unless the switch is exactly 1", async () => {
    const full = JSON.stringify(readJson(join(GOLDENS, "full.tools-list.json")));
    expect(unbridgedWire(FULL)).toBe(full);
    const served = await Promise.all(["0", "", "true", "yes", "on"].map((value) => toolsListWire(PROXY_SOURCE, { ...PROFILES[FULL]!, OMB_AGENTS_TOOL_BRIDGE: value })));
    for (const wire of [...served, await toolsListWire(PROXY_SOURCE, PROFILES[FULL]!)]) expect(wire).toBe(full);
  }, 60_000);
});

describe("agents proxy with the tool bridge on, from the packaged bundle", () => {
  let directory = "";
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("serves the same bridged bytes and answers the bridge's own calls, with no source tree beside it", async () => {
    // The proxy runs as its own process in a packaged build, so the bridge
    // and the ranker it searches with have to be inlined into the one
    // agents-proxy.js that scripts/bundle-server.mjs's options produce.
    directory = realpathSync(mkdtempSync(join(tmpdir(), "omb-agents-proxy-bridge-bundle-")));
    await build({
      entryPoints: [PROXY_SOURCE],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outbase: join(HERE, ".."),
      outdir: directory,
      logLevel: "silent",
    });
    const bundled = join(directory, "drivers", "agents-proxy.js");
    expect(existsSync(bundled)).toBe(true);
    const source = readFileSync(bundled, "utf8");
    expect(source).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(source).not.toMatch(/import\(\s*["']\.{1,2}\//);
    expect(await bridgedWireForEveryProfile(bundled)).toEqual(wires);

    const env = { ...PROFILES["non-chief"]!, ...BRIDGE_ON };
    const fromSource = await proxyAnswers(PROXY_SOURCE, env, BRIDGE_REQUESTS);
    const [found, shapeless, outside] = await proxyAnswers(bundled, env, BRIDGE_REQUESTS);
    expect((JSON.parse(found!.result!.content![0]!.text) as { matches: Tool[] }).matches[0]!.name).toBe("create_trigger");
    expect(shapeless!.result!.isError).toBe(true);
    expect(shapeless!.result!.content![0]!.text).toContain('use_tool needs { "name": ');
    // a bot that is not a Chief: create_bot is not one of its tools
    expect(outside!.result).toEqual({ content: [{ type: "text", text: "Unknown tool: create_bot" }], isError: true });
    expect([found, shapeless, outside]).toEqual(fromSource);
    // the argument checker a first draft bundled is gone: no schema compiler rides in the proxy
    expect(source).not.toMatch(/ajv/i);
  }, 120_000);
});

describe("agents proxy tools/list wire size with the tool bridge on", () => {
  it("prints each bridged profile beside its unbridged twin, and what the two bridge tools cost", () => {
    const own = (name: string) => toolsOf(wires[name]!).slice(-2);
    const lines = [
      "agents proxy tools/list with the tool bridge on, UTF-8 bytes of the serialized result",
      "",
      "  bridged  tools  unbridged  tools  saved  profile",
      ...Object.entries(wires).map(([name, wire]) => {
        const twin = unbridgedWire(name);
        const saved = `${Math.round((1 - bytes(wire) / bytes(twin)) * 100)}%`;
        return `  ${String(bytes(wire)).padStart(7)}  ${String(toolsOf(wire).length).padStart(5)}  ${String(bytes(twin)).padStart(9)}  ${String(toolsOf(twin).length).padStart(5)}  ${saved.padStart(5)}  ${name}`;
      }),
      "",
      "the two bridge tools (whole definition | input schema alone); find_tool's description grows with the names it lists:",
      ...[FULL, "non-chief"].flatMap((name) => own(name).map((tool) =>
        `  ${String(bytes(JSON.stringify(tool))).padStart(6)} ${String(bytes(JSON.stringify(tool.inputSchema))).padStart(6)}  ${tool.name}  (${name})`)),
    ];
    console.log(lines.join("\n"));
    for (const [name, wire] of Object.entries(wires)) expect(bytes(wire), name).toBeLessThan(bytes(unbridgedWire(name)) / 2);
  });

  it.each(Object.keys(PROFILES))("%s stays within 2% of its budget baseline", (name) => {
    const baseline = BUDGET_BASELINE[name];
    expect(baseline, `${name} has no BUDGET_BASELINE entry`).toBeTypeOf("number");
    const actual = bytes(wires[name]!);
    expect(actual, `${name} grew past its budget (${baseline} + 2%). Trim the hot list, or raise BUDGET_BASELINE on purpose.`)
      .toBeLessThanOrEqual(Math.floor(baseline! * 1.02));
    expect(actual, `${name} shrank by more than 2%. Lower BUDGET_BASELINE to ${actual} so the saving cannot creep back.`)
      .toBeGreaterThanOrEqual(Math.ceil(baseline! * 0.98));
  });
});
