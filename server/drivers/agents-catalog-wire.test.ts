// What the agents proxy puts on the wire for `tools/list`, pinned byte for
// byte and measured.
//
// Two jobs:
//
// 1. GOLDEN. Every engine turns this JSON into its provider's function-call
//    format, and a schema that changes shape in passing has broken production
//    before (#544: a `oneOf` mangled by a provider's conversion). So the exact
//    serialized result is checked in for every mount profile the harness can
//    ask for, and a refactor of the proxy has to reproduce it to the byte.
//    The proxy is spawned the way a driver's mcpServers entry spawns it, from
//    source and from the esbuild bundle every packaged build ships, so "the
//    same bytes" is a statement about the real process, not about a helper.
//
// 2. WIRE SIZE. The catalog is sent to the model on every turn. The often
//    quoted "~37 KB" was a count of indented source, not of this JSON. The
//    numbers printed here are the real ones, and the budget below fails CI
//    when a profile grows by more than 2%.
//
// Changing a tool on purpose: run this file once with
// UPDATE_AGENTS_CATALOG_GOLDENS=1, review the golden diff like any other wire
// change, and move BUDGET_BASELINE by hand. The baseline is deliberately not
// rewritten by the update run: growth should be a decision somebody typed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForExit } from "../testing/cleanup.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_SOURCE = join(HERE, "agents-proxy.ts");
const GOLDENS = join(HERE, "agents-catalog-goldens");
const UPDATE = process.env.UPDATE_AGENTS_CATALOG_GOLDENS === "1";

interface Profile {
  /** Which full golden every tool of this profile must be found in. */
  family: "direct" | "room" | "external";
  env: Record<string, string>;
}

const flag = (on: boolean) => (on ? "1" : "0");

/** Every combination server/index.ts agentsIntegration() can produce, plus the
 * standing external runtime (docs/self-hosting.md), which sets only its own
 * switch. The bot id is fixed because a room turn writes it into the
 * start_thread schema. */
function profiles(): Record<string, Profile> {
  const all: Record<string, Profile> = {};
  for (const room of [false, true]) {
    for (const ownThread of room ? [false, true] : [false]) {
      for (const skills of [false, true]) {
        for (const shared of [false, true]) {
          const name = [room ? "room" : "direct", ownThread && "own-thread", skills && "skills", shared && "shared"]
            .filter(Boolean).join("+");
          all[name] = {
            family: room ? "room" : "direct",
            env: {
              OMB_ROOM_TURN: flag(room),
              OMB_OWN_THREAD_CREATION: flag(ownThread),
              OMB_SKILL_AUTHORING_ENABLED: flag(skills),
              OMB_SHARED_COMPUTERS_ENABLED: flag(shared),
            },
          };
        }
      }
    }
  }
  all.external = { family: "external", env: { OMB_EXTERNAL_RUNTIME: "1" } };
  // The external switch wins over every other one; pin that it still does.
  all["external+everything"] = {
    family: "external",
    env: {
      OMB_EXTERNAL_RUNTIME: "1",
      OMB_ROOM_TURN: "1",
      OMB_OWN_THREAD_CREATION: "1",
      OMB_SKILL_AUTHORING_ENABLED: "1",
      OMB_SHARED_COMPUTERS_ENABLED: "1",
    },
  };
  return all;
}

const PROFILES = profiles();
/** The profile of each family that mounts the most: checked in whole, as
 * readable JSON. Every other profile is a by-name subset of one of these and
 * is pinned by tool names, byte count and sha256 in profiles.json. */
const FULL = { direct: "direct+skills+shared", room: "room+own-thread+skills+shared", external: "external" } as const;

/** Bytes measured when the budget was last set. A profile may not exceed this
 * by more than 2%, and may not undercut it by more than 2% either: a smaller
 * catalog is the goal, so lock the win in by lowering the number. */
const BUDGET_BASELINE: Record<string, number> = {
  "direct": 38_270,
  "direct+shared": 40_015,
  "direct+skills": 40_196,
  "direct+skills+shared": 41_941,
  "room": 36_697,
  "room+shared": 38_442,
  "room+skills": 38_623,
  "room+skills+shared": 40_368,
  "room+own-thread": 37_984,
  "room+own-thread+shared": 39_729,
  "room+own-thread+skills": 39_910,
  "room+own-thread+skills+shared": 41_655,
  "external": 3_030,
  "external+everything": 3_030,
};

const RPC_PREFIX = '{"jsonrpc":"2.0","id":1,"result":';

/** The exact `result` text of one tools/list answer from a freshly spawned
 * proxy. Sliced out of the raw stdout line, never re-serialized. */
async function toolsListWire(entry: string, env: Record<string, string>): Promise<string> {
  // A developer shell (or an OpenMausBot turn running this suite) can carry
  // OMB_* switches of its own; the profile must be the only source.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const child = spawn(process.execPath, [entry], {
    env: { ...inherited, OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-golden", OMB_THREAD_ID: "thread-golden", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) resolve(buffer.slice(0, newline));
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`agents proxy exited (${code}) before answering tools/list`)));
      // stdin stays open until the answer is read: closing it makes the proxy
      // exit, and on Windows a pipe write still in flight is lost with it.
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    });
    expect(line.startsWith(RPC_PREFIX) && line.endsWith("}")).toBe(true);
    return line.slice(RPC_PREFIX.length, -1);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

async function wireForEveryProfile(entry: string): Promise<Record<string, string>> {
  const names = Object.keys(PROFILES);
  const wires = await Promise.all(names.map((name) => toolsListWire(entry, PROFILES[name]!.env)));
  return Object.fromEntries(names.map((name, index) => [name, wires[index]!]));
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
type Tool = { name: string };
const toolsOf = (wire: string) => (JSON.parse(wire) as { tools: Tool[] }).tools;

const goldenPath = (family: keyof typeof FULL) => join(GOLDENS, `${family}-full.tools-list.json`);
const manifestPath = join(GOLDENS, "profiles.json");
// Goldens are stored pretty-printed so a wire change reads as a diff, and are
// compared after JSON.parse, so a CRLF checkout on Windows cannot fail them.
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const manifestOf = (wires: Record<string, string>) =>
  Object.fromEntries(Object.entries(wires).map(([name, wire]) => [
    name,
    { bytes: bytes(wire), sha256: sha256(wire), tools: toolsOf(wire).map((tool) => tool.name) },
  ]));

let wires: Record<string, string> = {};

beforeAll(async () => {
  wires = await wireForEveryProfile(PROXY_SOURCE);
  if (UPDATE) {
    for (const family of Object.keys(FULL) as (keyof typeof FULL)[]) writeJson(goldenPath(family), JSON.parse(wires[FULL[family]]!));
    writeJson(manifestPath, manifestOf(wires));
  }
}, 120_000);

describe("agents proxy tools/list golden", () => {
  it("round-trips through JSON.parse unchanged, so a parsed golden can stand for the bytes", () => {
    for (const wire of Object.values(wires)) expect(JSON.stringify(JSON.parse(wire))).toBe(wire);
  });

  it.each(Object.keys(FULL) as (keyof typeof FULL)[])("%s: the fullest profile is byte-identical to its golden", (family) => {
    const golden = readJson(goldenPath(family));
    const wire = wires[FULL[family]]!;
    // Structural first: a readable diff naming the tool and field that moved.
    expect(JSON.parse(wire)).toEqual(golden);
    // Then the bytes: key order and number formatting included.
    expect(wire).toBe(JSON.stringify(golden));
  });

  it("every profile matches its pinned tool names, byte count and sha256", () => {
    expect(manifestOf(wires)).toEqual(readJson(manifestPath));
  });

  it("every profile is a by-name subset of its family's full golden, tool bytes included", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const full = new Map(toolsOf(wires[FULL[profile.family]]!).map((tool) => [tool.name, JSON.stringify(tool)]));
      for (const tool of toolsOf(wires[name]!)) {
        expect(JSON.stringify(tool), `${name}: ${tool.name}`).toBe(full.get(tool.name));
      }
    }
  });

  it("is what the catalog module computes in-process, so another front end mounts the same tools", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const tools = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", ...profile.env }));
      expect(JSON.stringify({ tools }), name).toBe(wires[name]);
    }
  });

  it("writes the routine fields out identically in both routine tools", () => {
    // One source constant, serialized in full twice: see the wire-size table
    // for what that costs, and the next test for why it is not a $ref.
    type RoutineTool = Tool & { inputSchema: { properties: Record<string, unknown> & { changes: { properties: Record<string, unknown> } } } };
    const tools = new Map(toolsOf(wires[FULL.direct]!).map((tool) => [tool.name, tool as RoutineTool]));
    const created = tools.get("propose_routine")!.inputSchema.properties;
    const changed = tools.get("propose_routine_action")!.inputSchema.properties.changes.properties;
    expect(Object.keys(changed).length).toBeGreaterThan(0);
    for (const field of Object.keys(changed)) expect(JSON.stringify(created[field]), field).toBe(JSON.stringify(changed[field]));
    expect(Object.keys(created).slice(0, Object.keys(changed).length)).toEqual(Object.keys(changed));
  });

  it("uses no JSON-Schema keyword a provider conversion is known to drop or mangle", () => {
    // #544. Reuse in the source is one constant referenced twice; on the wire
    // the schema stays written out in full, with no indirection or branches.
    for (const [name, wire] of Object.entries(wires)) {
      expect(wire.match(/"(\$ref|\$defs|definitions|oneOf|anyOf|allOf)":/g), name).toBeNull();
    }
  });
});

describe("agents proxy tools/list from the packaged bundle", () => {
  let directory = "";
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("serves the same bytes with no source tree beside it", async () => {
    // Same esbuild options as scripts/bundle-server.mjs, which produces the
    // dist-server/ that the desktop app, the npm package and the container
    // image all copy whole. The proxy runs as its own process there, so every
    // module it imports has to be inlined into this one file.
    directory = realpathSync(mkdtempSync(join(tmpdir(), "omb-agents-proxy-bundle-")));
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
    expect(readFileSync(bundled, "utf8")).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(await wireForEveryProfile(bundled)).toEqual(wires);
  }, 120_000);
});

describe("agents proxy tools/list wire size", () => {
  it("prints per-tool and total UTF-8 bytes", () => {
    const shown = Object.values(FULL);
    const perTool = new Map<string, Record<string, number>>();
    for (const name of shown) {
      for (const tool of toolsOf(wires[name]!)) {
        perTool.set(tool.name, { ...perTool.get(tool.name), [name]: bytes(JSON.stringify(tool)) });
      }
    }
    const largest = (sizes: Record<string, number>) => Math.max(...Object.values(sizes));
    const rows = [...perTool.entries()].sort((a, b) => largest(b[1]) - largest(a[1]));
    const lines = [
      "agents proxy tools/list, UTF-8 bytes of the serialized result",
      "",
      "total per profile:",
      ...Object.entries(wires).map(([name, wire]) => `  ${String(bytes(wire)).padStart(6)}  ${String(toolsOf(wire).length).padStart(2)} tools  ${name}`),
      "",
      `per tool (${shown.join(" | ")}); every other profile is a by-name subset with identical tool bytes:`,
      ...rows.map(([tool, sizes]) => `  ${shown.map((name) => String(sizes[name] ?? "-").padStart(6)).join(" ")}  ${tool}`),
    ];
    console.log(lines.join("\n"));
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PROFILES))("%s stays within 2% of its budget baseline", (name) => {
    const baseline = BUDGET_BASELINE[name];
    expect(baseline, `${name} has no BUDGET_BASELINE entry`).toBeTypeOf("number");
    const actual = bytes(wires[name]!);
    expect(actual, `${name} grew past its budget (${baseline} + 2%). Trim the catalog, or raise BUDGET_BASELINE on purpose.`)
      .toBeLessThanOrEqual(Math.floor(baseline! * 1.02));
    expect(actual, `${name} shrank by more than 2%. Lower BUDGET_BASELINE to ${actual} so the saving cannot creep back.`)
      .toBeGreaterThanOrEqual(Math.ceil(baseline! * 0.98));
  });
});
