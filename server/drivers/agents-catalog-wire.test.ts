// Pins the agents proxy's tools/list wire byte for byte, from source and from the bundle, and budgets its
// size: every engine converts this JSON for its provider, and it rides every turn. To change a tool on
// purpose, run with UPDATE_AGENTS_CATALOG_GOLDENS=1, review the golden diff, and move BUDGET_BASELINE by hand.
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
  env: Record<string, string>;
}

const flag = (on: boolean) => (on ? "1" : "0");

/** Every combination agentsIntegration() can produce; a name without "+non-chief" is a Chief of Staff's turn. */
function profiles(): Record<string, Profile> {
  const all: Record<string, Profile> = {};
  for (const chief of [true, false]) {
    for (const skills of [false, true]) {
      for (const shared of [false, true]) {
        for (const voice of [false, true]) {
          const name = [skills && "skills", shared && "shared", voice && "voice", !chief && "non-chief"]
            .filter(Boolean).join("+") || "default";
          all[name] = {
            env: {
              OMB_SKILL_AUTHORING_ENABLED: flag(skills),
              OMB_SHARED_COMPUTERS_ENABLED: flag(shared),
              OMB_VOICE_NOTES: flag(voice),
              OMB_CHIEF_OF_STAFF: flag(chief),
            },
          };
        }
      }
    }
  }
  for (const name of ["skills+shared+voice", "skills+shared+voice+non-chief"]) {
    all[`${name}+cloud-home`] = { env: { ...all[name]!.env, OMB_CLOUD_HOME: "1" } };
  }
  all["skills+shared+voice+escalations"] = { env: { ...all["skills+shared+voice"]!.env, OMB_ESCALATIONS: "1" } };
  // Research is on only with a treg key or a Cloud plan and the bot's switch; the fullest profile carries it.
  all["skills+shared+voice+escalations+x"] = { env: { ...all["skills+shared+voice+escalations"]!.env, OMB_X_RESEARCH: "1" } };
  // A Team Cloud mounts message_person; the fullest profile carries it.
  all["skills+shared+voice+escalations+x+team"] = { env: { ...all["skills+shared+voice+escalations+x"]!.env, OMB_TEAM_PEOPLE: "1" } };
  all["default+legacy-switches"] = {
    env: { ...all.default!.env, OMB_ROOM_TURN: "1", OMB_OWN_THREAD_CREATION: "1", OMB_EXTERNAL_RUNTIME: "1" },
  };
  // The person's MausBot holds a Chief's powers and adds its notification pair; MAUSBOT_ADDS bounds what that costs.
  for (const name of ["default", "skills+shared+voice"]) all[`${name}+mausbot`] = { env: { ...all[name]!.env, OMB_MAUSBOT: "1" } };
  return all;
}

const PROFILES = profiles();
const CHIEF_ONLY_TOOLS = ["create_bot", "list_team_setup", "list_team_library", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread"];
const CHIEF_TARGET_TOOLS = ["propose_profile", "propose_model"];
const CHIEF_PROFILE_TARGET = " A Chief of Staff may pass for_bot_id (from list_bots) for a requested change to another bot in its section.";
const TEAMWORK_TOOLS = ["list_room_targets", "coordinate_bots", "assignment_status", "list_bots", "list_rooms", "list_threads", "close_thread", "start_thread", "post_to_room"];
const MAUSBOT_TOOLS = ["list_unread_notifications", "mark_notifications_read"];
/** MausBot's tools may make its list at most this much longer than the same Chief's without them. */
const MAUSBOT_ADDS = 0.02;
const RESEARCH_TOOLS = ["x_search", "x_user_posts", "x_post", "x_profile", "research_search", "research_endpoint", "research_call"];
/** The fullest profile, checked in whole; every other one is pinned by tool names, bytes and sha256. */
const FULL = "skills+shared+voice+escalations+x+team";

/** Bytes when the budget was last set; a profile may move at most 2% either way (lower it to lock in a win). */
const BUDGET_BASELINE: Record<string, number> = {
  "default": 62862,
  "voice": 63674,
  "shared": 64795,
  "shared+voice": 65607,
  "skills": 65681,
  "skills+voice": 66493,
  "skills+shared": 67614,
  "skills+shared+voice": 68426,
  "non-chief": 52943,
  "voice+non-chief": 53755,
  "shared+non-chief": 54876,
  "shared+voice+non-chief": 55688,
  "skills+non-chief": 55762,
  "skills+voice+non-chief": 56574,
  "skills+shared+non-chief": 57695,
  "skills+shared+voice+non-chief": 58507,
  "skills+shared+voice+cloud-home": 67481,
  "skills+shared+voice+non-chief+cloud-home": 57562,
  "default+legacy-switches": 62862,
  "default+mausbot": 63539,
  "skills+shared+voice+mausbot": 69103,
  "skills+shared+voice+escalations": 69286,
  "skills+shared+voice+escalations+x": 73924,
  "skills+shared+voice+escalations+x+team": 74589,
};

const RPC_PREFIX = '{"jsonrpc":"2.0","id":1,"result":';

/** One tools/list `result` from a fresh proxy, sliced out of the raw stdout line, never re-serialized. */
async function toolsListWire(entry: string, env: Record<string, string>): Promise<string> {
  // A developer shell or an OpenMausBot turn can carry OMB_* switches; the profile must be the only source.
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
      // stdin stays open until the answer is read: on Windows a pipe write in flight dies with the proxy.
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

const goldenPath = join(GOLDENS, "full.tools-list.json");
const manifestPath = join(GOLDENS, "profiles.json");
// Pretty-printed for readable diffs and compared after JSON.parse, so a CRLF checkout cannot fail them.
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
    writeJson(goldenPath, JSON.parse(wires[FULL]!));
    writeJson(manifestPath, manifestOf(wires));
  }
}, 120_000);

describe("agents proxy tools/list golden", () => {
  it("round-trips through JSON.parse unchanged, so a parsed golden can stand for the bytes", () => {
    for (const wire of Object.values(wires)) expect(JSON.stringify(JSON.parse(wire))).toBe(wire);
  });

  it("the fullest profile is byte-identical to its golden", () => {
    const golden = readJson(goldenPath);
    const wire = wires[FULL]!;
    expect(JSON.parse(wire)).toEqual(golden);
    expect(wire).toBe(JSON.stringify(golden));
  });

  it("every profile matches its pinned tool names, byte count and sha256", () => {
    expect(manifestOf(wires)).toEqual(readJson(manifestPath));
  });

  it("every profile is a by-name subset of the full golden, tool bytes included", () => {
    const full = new Map(toolsOf(wires[FULL]!).map((tool) => [tool.name, JSON.stringify(tool)]));
    for (const [name, profile] of Object.entries(PROFILES)) {
      for (const tool of toolsOf(wires[name]!)) {
        if (profile.env.OMB_CLOUD_HOME === "1" && tool.name === "select_computer") continue;
        if (profile.env.OMB_CHIEF_OF_STAFF === "0" && CHIEF_TARGET_TOOLS.includes(tool.name)) continue;
        if (profile.env.OMB_MAUSBOT === "1" && MAUSBOT_TOOLS.includes(tool.name)) continue;
        expect(JSON.stringify(tool), `${name}: ${tool.name}`).toBe(full.get(tool.name));
      }
    }
  });

  it("gives every turn the one teamwork surface, with start_thread on the bot itself", () => {
    type SchemaTool = Tool & { description: string; inputSchema: { properties: Record<string, { enum?: string[]; description?: string }> } };
    for (const [name, wire] of Object.entries(wires)) {
      const tools = new Map((toolsOf(wire) as SchemaTool[]).map((tool) => [tool.name, tool]));
      for (const tool of TEAMWORK_TOOLS) expect(tools.has(tool), `${name}: ${tool}`).toBe(true);
      for (const alias of ["delegate_bot", "ask_bot", "send_to_bot", "check_delegation", "wait_delegation"]) expect(tools.has(alias), `${name}: ${alias}`).toBe(false);
      expect(JSON.stringify([...tools.values()])).not.toMatch(/Deprecated alias|works for this release/);
      const coordinate = tools.get("coordinate_bots")!.inputSchema.properties;
      expect(Object.keys(coordinate)).toEqual(["group_id", "bot_ids", "message", "reason", "rework", "thread", "title", "in_my_folder", "reply", "consult", "done_when"]);
      expect(coordinate.thread!.enum).toEqual(["standing", "new"]);
      expect(coordinate.reply!.enum).toEqual(["resume", "none"]);
      expect(Object.keys(tools.get("assignment_status")!.inputSchema.properties)).toEqual(["id", "wait_ms"]);
      expect(tools.get("start_thread")!.inputSchema.properties.bot_id!.enum).toEqual(["bot-golden"]);
      expect(wire).not.toMatch(/Brief synchronous consultation|DEFAULT FOR ASSIGNING WORK|BLOCKING status tool/);
    }
  });

  it("mounts raise_escalation only where chief escalations are on", () => {
    const names = (wire: string) => toolsOf(wire).map((tool) => tool.name);
    expect(names(wires["skills+shared+voice+escalations"]!).filter((tool) => tool !== "raise_escalation")).toEqual(names(wires["skills+shared+voice"]!));
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(names(wires[name]!).includes("raise_escalation"), name).toBe(profile.env.OMB_ESCALATIONS === "1");
    }
  });

  it("mounts message_person only on a Team Cloud, and adds nothing else", () => {
    const names = (wire: string) => toolsOf(wire).map((tool) => tool.name);
    expect(names(wires[FULL]!).filter((tool) => tool !== "message_person")).toEqual(names(wires["skills+shared+voice+escalations+x"]!));
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(names(wires[name]!).includes("message_person"), name).toBe(profile.env.OMB_TEAM_PEOPLE === "1");
    }
  });

  it("ignores the switches that once picked a catalog profile", () => {
    expect(wires["default+legacy-switches"]).toBe(wires.default);
    const profile = catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", OMB_CHIEF_OF_STAFF: "1", OMB_ROOM_TURN: "1", OMB_OWN_THREAD_CREATION: "1", OMB_EXTERNAL_RUNTIME: "1" });
    expect(JSON.stringify({ tools: availableTools(profile) })).toBe(wires.default);
    expect(profile).not.toHaveProperty("coordinating");
    expect(profile).not.toHaveProperty("externalRuntime");
    expect(profile).not.toHaveProperty("ownThreadCreation");
  });

  it("shows a Cloud home's bots no Local VM and no this computer, and every other server both", () => {
    type SelectTool = Tool & { inputSchema: { properties: { surface: { enum: string[]; description: string } } } };
    const select = (wire: string) => toolsOf(wire).find((tool) => tool.name === "select_computer") as SelectTool;
    const cloudHome = Object.keys(PROFILES).filter((name) => name.endsWith("+cloud-home"));
    expect(cloudHome).toHaveLength(2);
    for (const name of cloudHome) {
      const desktop = wires[name.slice(0, -"+cloud-home".length)]!;
      const names = toolsOf(wires[name]!).map((tool) => tool.name);
      expect(names).toEqual(toolsOf(desktop).map((tool) => tool.name).filter((tool) => tool !== "vm_exec"));
      expect(select(desktop).inputSchema.properties.surface.enum).toEqual(["auto", "cloud", "vm", "local", "browser"]);
      expect(toolsOf(desktop).map((tool) => tool.name)).toContain("vm_exec");
      const surface = select(wires[name]!).inputSchema.properties.surface;
      expect(surface.enum).toEqual(["auto", "cloud", "browser"]);
      expect(surface.description).not.toMatch(/\b(?:vm|local) =/);
    }
  });

  it("shows only a Chief of Staff the Chief-only tools, and for_bot_id on another bot's profile or model", () => {
    type SchemaTool = Tool & { description: string; inputSchema: { properties: Record<string, unknown> } };
    const nonChief = Object.keys(PROFILES).filter((name) => PROFILES[name]!.env.OMB_CHIEF_OF_STAFF === "0");
    expect(nonChief).toHaveLength(9);
    for (const name of nonChief) {
      const chiefTools = toolsOf(wires[name === "non-chief" ? "default" : name.replace("+non-chief", "")]!) as SchemaTool[];
      const tools = new Map((toolsOf(wires[name]!) as SchemaTool[]).map((tool) => [tool.name, tool]));
      expect(chiefTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(CHIEF_ONLY_TOOLS));
      expect([...tools.keys()], name).toEqual(chiefTools.map((tool) => tool.name).filter((tool) => !CHIEF_ONLY_TOOLS.includes(tool)));
      for (const chiefTool of chiefTools.filter((tool) => tools.has(tool.name))) {
        let expected: SchemaTool = chiefTool;
        if (CHIEF_TARGET_TOOLS.includes(chiefTool.name)) {
          const { for_bot_id: forBotId, ...properties } = chiefTool.inputSchema.properties;
          expect(forBotId, `${name}: ${chiefTool.name}`).toBeDefined();
          expected = { ...chiefTool, description: chiefTool.description.replace(CHIEF_PROFILE_TARGET, ""), inputSchema: { ...chiefTool.inputSchema, properties } };
        }
        expect(JSON.stringify(tools.get(chiefTool.name)), `${name}: ${chiefTool.name}`).toBe(JSON.stringify(expected));
      }
      expect(chiefTools.find((tool) => tool.name === "propose_profile")!.description).toContain(CHIEF_PROFILE_TARGET);
      expect(JSON.stringify(CHIEF_TARGET_TOOLS.map((tool) => tools.get(tool)))).not.toContain("for_bot_id");
      for (const trigger of ["list_triggers", "create_trigger", "manage_trigger"]) {
        expect(tools.get(trigger)!.inputSchema.properties, `${name}: ${trigger}`).toHaveProperty("for_bot_id");
      }
    }
  });

  it("shows the X and research tools only where research is on, and adds nothing else", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const names = toolsOf(wires[name]!).map((tool) => tool.name);
      for (const tool of RESEARCH_TOOLS) expect(names.includes(tool), `${name}: ${tool}`).toBe(profile.env.OMB_X_RESEARCH === "1");
    }
    const switchedOn = Object.keys(PROFILES).filter((name) => name.endsWith("+x"));
    expect(switchedOn).toHaveLength(1);
    for (const name of switchedOn) {
      const without = toolsOf(wires[name.slice(0, -"+x".length)]!).map((tool) => tool.name);
      expect(toolsOf(wires[name]!).map((tool) => tool.name).filter((tool) => !RESEARCH_TOOLS.includes(tool))).toEqual(without);
    }
  });

  it("is what the catalog module computes in-process, so another front end mounts the same tools", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const tools = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", ...profile.env }));
      expect(JSON.stringify({ tools }), name).toBe(wires[name]);
    }
  });

  it("writes the trigger fields out identically in create_trigger and manage_trigger", () => {
    type TriggerTool = Tool & { inputSchema: { properties: Record<string, unknown> & { changes: { properties: Record<string, unknown> } } } };
    const tools = new Map(toolsOf(wires[FULL]!).map((tool) => [tool.name, tool as TriggerTool]));
    const created = tools.get("create_trigger")!.inputSchema.properties;
    const changed = tools.get("manage_trigger")!.inputSchema.properties.changes.properties;
    expect(Object.keys(changed).length).toBeGreaterThan(0);
    for (const field of Object.keys(changed)) expect(JSON.stringify(created[field]), field).toBe(JSON.stringify(changed[field]));
    expect(Object.keys(created).slice(1, Object.keys(changed).length + 1)).toEqual(Object.keys(changed));
  });

  it("uses no JSON-Schema keyword a provider conversion is known to drop or mangle", () => {
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
      // Same esbuild options as scripts/bundle-server.mjs: the proxy runs as its own process from one inlined file.
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
    const shown = [FULL, "skills+shared+voice+non-chief"];
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

  it.each(Object.keys(PROFILES).filter((name) => name.endsWith("+mausbot")))("%s adds at most 2% to the same Chief's list", (name) => {
    const without = name.slice(0, -"+mausbot".length);
    const tools = toolsOf(wires[name]!).map((tool) => tool.name);
    expect(tools.slice(-MAUSBOT_TOOLS.length)).toEqual(MAUSBOT_TOOLS);
    expect(tools.slice(0, -MAUSBOT_TOOLS.length)).toEqual(toolsOf(wires[without]!).map((tool) => tool.name));
    expect(bytes(wires[name]!)).toBeLessThanOrEqual(Math.floor(bytes(wires[without]!) * (1 + MAUSBOT_ADDS)));
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
