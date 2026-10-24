// The agents tool bridge as a pure module: which tools of a profile stay
// listed, which go behind find_tool / use_tool, what a search returns, what a
// bridged call comes to, and the three small helpers the gates and the
// harness use to see through it. The stdio surface built on it is driven end
// to end in agents-proxy.test.ts, and its bytes are pinned in
// agents-bridge-wire.test.ts.
import { describe, expect, it } from "vitest";
import { isOutboundTool } from "../../shared/outbound.ts";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { READ_ONLY_ANNOTATIONS } from "../agent-tool-policy.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { availableTools, catalogProfileFromEnv, type CatalogProfile } from "./agents-catalog.ts";
import {
  BRIDGE_HOT_TOOL_NAMES,
  BRIDGE_NAMES_MAX_CHARS,
  FIND_MATCHES_MAX,
  FIND_TOOL,
  TOOL_BRIDGE_ENV,
  USE_TOOL,
  bridgedCallTarget,
  bridgedCallTitle,
  createToolBridge,
  unbridgedServer,
  type BridgeTool,
} from "./agents-bridge.ts";

const flag = (on: boolean) => (on ? "1" : "0");
const profile = (options: { chief?: boolean; skills?: boolean; shared?: boolean; voice?: boolean; cloudHome?: boolean; memory?: boolean; botId?: string } = {}): CatalogProfile =>
  catalogProfileFromEnv({
    OMB_BOT_ID: options.botId ?? "bot-bridge",
    OMB_CHIEF_OF_STAFF: flag(options.chief ?? false),
    OMB_SKILL_AUTHORING_ENABLED: flag(options.skills ?? false),
    OMB_SHARED_COMPUTERS_ENABLED: flag(options.shared ?? false),
    OMB_VOICE_NOTES: flag(options.voice ?? false),
    OMB_CLOUD_HOME: flag(options.cloudHome ?? false),
    OMB_MEMORY_ENABLED: flag(options.memory ?? true),
  });

/** Every switch combination the harness can ask for, as the wire test's
 * matrix does, plus the two the matrix leaves out: memory off and Watcher. */
function everyProfile(): Array<{ name: string; profile: CatalogProfile }> {
  const all: Array<{ name: string; profile: CatalogProfile }> = [];
  for (const chief of [true, false]) for (const skills of [false, true]) for (const shared of [false, true]) for (const voice of [false, true]) for (const cloudHome of [false, true]) {
    all.push({ name: JSON.stringify({ chief, skills, shared, voice, cloudHome }), profile: profile({ chief, skills, shared, voice, cloudHome }) });
  }
  all.push({ name: "memory off", profile: profile({ memory: false }) });
  all.push({ name: "watcher", profile: profile({ botId: WATCHER_OPTIONS_CARD_BOT_ID }) });
  return all;
}

const bridgeFor = (options: Parameters<typeof profile>[0] = {}) => createToolBridge(availableTools(profile(options)) as BridgeTool[]);
const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);
const FULL_CHIEF = { chief: true, skills: true, shared: true, voice: true } as const;
const CHIEF_ONLY = ["create_bot", "list_team_setup", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread", "cancel_job"];

type Match = { name: string; description: string; inputSchema: Record<string, unknown> };
type FindPayload = { matches: Match[]; next: string };
const found = async (bridge: ReturnType<typeof createToolBridge>, query: string) => {
  const answer = await bridge.find({ query });
  expect(answer.isError, answer.text).toBeFalsy();
  return JSON.parse(answer.text) as FindPayload;
};
/** Every spelling an engine reports an agents tool under in a turn's
 * activity: bare (Codex), Claude's, an ACP agent's, the chat runtime's and Pi's. */
const reportedAs = (name: string) => [name, `mcp__agents__${name}`, `agents__${name}`, `agents_${name}`];

describe("what a bridged turn is listed", () => {
  it("keeps the hot tools, in catalog order, then find_tool and use_tool", () => {
    // A bot that is not a Chief, with nothing optional on: the smallest turn.
    expect(names(bridgeFor().listed)).toEqual([
      "tool_result_read",
      "list_room_targets",
      "coordinate_bots",
      "list_bots",
      "list_rooms",
      "select_computer",
      "attach_file",
      "publish_page",
      "post_to_room",
      "request_credential",
      "request_sign_in",
      "fill_login",
      "memory_update",
      FIND_TOOL,
      USE_TOOL,
    ]);
    // and the fullest: a Watcher with a voice, whatever its role and features
    expect(names(bridgeFor({ ...FULL_CHIEF, botId: WATCHER_OPTIONS_CARD_BOT_ID }).listed)).toEqual([
      "create_options_card",
      "tool_result_read",
      "list_room_targets",
      "coordinate_bots",
      "list_bots",
      "list_rooms",
      "select_computer",
      "attach_file",
      "publish_page",
      "post_to_room",
      "request_credential",
      "request_sign_in",
      "fill_login",
      "send_voice_note",
      "memory_update",
      FIND_TOOL,
      USE_TOOL,
    ]);
  });

  it("names every hot tool the catalog really has, so a renamed tool cannot fall out of the list unnoticed", () => {
    const everyName = new Set(everyProfile().flatMap(({ profile: turn }) => names(availableTools(turn))));
    for (const hot of BRIDGE_HOT_TOOL_NAMES) expect(everyName.has(hot), hot).toBe(true);
    // 11 to 14 of them on any one turn, always fewer than the turn has
    for (const { name, profile: turn } of everyProfile()) {
      const tools = availableTools(turn);
      const hot = createToolBridge(tools as BridgeTool[]).listed.length - 2;
      expect(hot, name).toBeGreaterThanOrEqual(11);
      expect(hot, name).toBeLessThanOrEqual(14);
      expect(hot, name).toBeLessThan(tools.length / 2);
    }
  });

  it("adds a hot tool only where the profile has it: a voice, the Watcher's card, memory", () => {
    expect(names(bridgeFor({ voice: true }).listed)).toContain("send_voice_note");
    expect(names(bridgeFor().listed)).not.toContain("send_voice_note");
    expect(names(bridgeFor({ botId: WATCHER_OPTIONS_CARD_BOT_ID }).listed)[0]).toBe("create_options_card");
    expect(names(bridgeFor().listed)).not.toContain("create_options_card");
    expect(names(bridgeFor({ memory: false }).listed)).not.toContain("memory_update");
    // A role and the other features change only what sits behind use_tool.
    for (const options of [{ chief: true }, { skills: true }, { shared: true }, { cloudHome: true }]) {
      expect(names(bridgeFor(options).listed), JSON.stringify(options)).toEqual(names(bridgeFor().listed));
    }
  });

  it("lists every hot tool exactly as the unbridged turn does, and loses none of the profile", () => {
    for (const { name, profile: turn } of everyProfile()) {
      const tools = availableTools(turn) as BridgeTool[];
      const bridge = createToolBridge(tools);
      const listed = bridge.listed.filter((tool) => tool.name !== FIND_TOOL && tool.name !== USE_TOOL);
      // the same objects, so the same bytes on the wire
      for (const tool of listed) expect(tool, `${name}: ${tool.name}`).toBe(tools.find((entry) => entry.name === tool.name));
      // listed and hidden together are the profile, each tool once, in order
      const order = new Map(tools.map((tool, index) => [tool.name, index]));
      const together = [...listed, ...bridge.hidden].sort((a, b) => order.get(a.name)! - order.get(b.name)!);
      expect(names(together), name).toEqual(names(tools));
      expect(names(bridge.listed).slice(-2), name).toEqual([FIND_TOOL, USE_TOOL]);
      expect(names(bridge.hidden).some((hidden) => BRIDGE_HOT_TOOL_NAMES.has(hidden)), name).toBe(false);
    }
  });

  it("never hides a tool the host counts as an outward action by its name", () => {
    // The restart policy (docs/runtime-contract.md §5) reads a turn's tool
    // names. A send must be seen under its own, so such a tool is always
    // listed, whatever the hot list says.
    for (const { name, profile: turn } of everyProfile()) {
      const tools = availableTools(turn) as BridgeTool[];
      const bridge = createToolBridge(tools);
      const outward = names(tools).filter((tool) => reportedAs(tool).some(isOutboundTool));
      expect(names(bridge.listed), name).toEqual(expect.arrayContaining(outward));
      for (const hidden of bridge.hidden) {
        for (const spelling of reportedAs(hidden.name)) expect(isOutboundTool(spelling), `${name}: ${spelling}`).toBe(false);
      }
    }
    // today that is publish_page, listed for it alone, and the two the hot list names anyway
    expect(names(availableTools(profile({ ...FULL_CHIEF }))).filter((tool) => reportedAs(tool).some(isOutboundTool))).toEqual(["publish_page", "post_to_room", "send_voice_note"]);
    // and the bridge's own two names are not outward either
    for (const spelling of [...reportedAs(USE_TOOL), ...reportedAs(FIND_TOOL)]) expect(isOutboundTool(spelling), spelling).toBe(false);
    // derived, not listed by hand: a future tool named like a send is kept,
    // under whichever spelling the host would recognize it
    for (const invented of ["send_weekly_digest", "invite_guest", "find_post"]) {
      const tool: BridgeTool = { name: invented, description: "Does it.", inputSchema: { type: "object", properties: {} } };
      expect(names(createToolBridge([...(availableTools(profile()) as BridgeTool[]), tool]).listed), invented).toContain(invented);
    }
  });

  it("gives the two bridge tools flat schemas no provider conversion can mangle", () => {
    const bridge = bridgeFor(FULL_CHIEF);
    const find = bridge.listed.find((tool) => tool.name === FIND_TOOL)!;
    const use = bridge.listed.find((tool) => tool.name === USE_TOOL)!;
    for (const tool of [find, use]) {
      // the guard agents-proxy.test.ts applies to the catalog's own schemas
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf|const|format|\$ref|\$defs|definitions)":/);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(find.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", description: expect.any(String) } },
      required: ["query"],
    });
    const useSchema = use.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(Object.keys(useSchema.properties)).toEqual(["name", "arguments"]);
    expect(useSchema.properties.name).toMatchObject({ type: "string" });
    // a plain object: the tool itself reads what is in it
    expect(useSchema.properties.arguments).toMatchObject({ type: "object", additionalProperties: true });
    expect(useSchema.required).toEqual(["name"]);
  });

  it("marks find_tool as the read it is, with the marks the catalog's reads carry, and claims nothing for use_tool", () => {
    const tools = availableTools(profile(FULL_CHIEF)) as BridgeTool[];
    const bridge = createToolBridge(tools);
    expect(bridge.listed.find((tool) => tool.name === FIND_TOOL)!.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    expect(bridge.listed.find((tool) => tool.name === FIND_TOOL)!.annotations).toEqual(tools.find((tool) => tool.name === "list_triggers")!.annotations);
    expect(bridge.listed.find((tool) => tool.name === USE_TOOL)).not.toHaveProperty("annotations");
  });

  it("names the hidden tools, and only those, in find_tool's description", () => {
    for (const { name, profile: turn } of everyProfile()) {
      const bridge = createToolBridge(availableTools(turn) as BridgeTool[]);
      const description = bridge.listed.find((tool) => tool.name === FIND_TOOL)!.description;
      const listedNames = description.slice(description.lastIndexOf(": ") + 2).replace(/\.$/, "").split(", ");
      expect(listedNames, name).toEqual(names(bridge.hidden));
    }
    // A bot that is not a Chief is not told the Chief-only tools exist.
    const plain = bridgeFor().listed.find((tool) => tool.name === FIND_TOOL)!.description;
    for (const chiefOnly of CHIEF_ONLY) {
      expect(plain, chiefOnly).not.toContain(chiefOnly);
      expect(bridgeFor({ chief: true }).listed.find((tool) => tool.name === FIND_TOOL)!.description, chiefOnly).toContain(chiefOnly);
    }
  });

  it("caps the list of names, and says how many it left out", () => {
    const many: BridgeTool[] = Array.from({ length: 400 }, (_, index) => ({
      name: `inspect_record_number_${index}`, description: "Reads one record.", inputSchema: { type: "object", properties: {} },
    }));
    const description = createToolBridge(many).listed.find((tool) => tool.name === FIND_TOOL)!.description;
    const list = description.slice(description.lastIndexOf(": ") + 2);
    expect(list.length).toBeLessThanOrEqual(BRIDGE_NAMES_MAX_CHARS);
    const shown = list.match(/inspect_record_number_\d+/g)!.length;
    expect(shown).toBeGreaterThan(10);
    expect(list).toMatch(new RegExp(`… and ${400 - shown} more\\.$`));
    // names are never cut in half
    expect(list.startsWith("inspect_record_number_0, inspect_record_number_1, ")).toBe(true);
  });

  it("keeps the bridge's two names out of the catalog", () => {
    const everyName = new Set(everyProfile().flatMap(({ profile: turn }) => names(availableTools(turn))));
    expect(everyName.has(FIND_TOOL)).toBe(false);
    expect(everyName.has(USE_TOOL)).toBe(false);
  });
});

describe("find_tool", () => {
  it.each([
    ["schedule a recurring task every morning", "create_trigger"],
    ["pause or delete one of my routines", "manage_trigger"],
    ["what routines do I have", "list_triggers"],
    ["change my name and title", "propose_profile"],
    ["switch this bot to a different model", "propose_model"],
    ["search my earlier conversations", "session_search"],
    ["run a shell command in the VM", "vm_exec"],
    ["add an MCP server", "add_mcp_server"],
    ["see how the threads I opened are going", "list_threads"],
    ["write a line to today's log", "memory_log"],
    ["remember a decision for the whole team", "propose_team_memory"],
    ["save this procedure as a reusable skill", "skill_manage"],
    ["create a new specialist bot", "create_bot"],
    ["delete a teammate", "propose_bot_deletion"],
    ["rename a room or change its members", "manage_room"],
    ["use the desktop the user shared", "shared_computer"],
    ["open a separate job for each pull request", "start_thread"],
    ["read the whole message from an old conversation", "session_read"],
    ["retry the failed thread", "retry_thread"],
    ["cron", "create_trigger"],
  ])("ranks the hidden tool first from how a person would ask: %s", async (query, expected) => {
    const matches = (await found(bridgeFor(FULL_CHIEF), query)).matches;
    expect(matches[0]!.name).toBe(expected);
    expect(matches.length).toBeLessThanOrEqual(FIND_MATCHES_MAX);
  });

  it.each([
    // each of these lands second, behind a tool that does nearly the same
    ["check how a hand-off is going", "assignment_status"],
    ["make a new room", "create_room"],
    ["my skills", "skills_list"],
    ["computers shared with this workspace", "list_shared_computers"],
  ])("returns the hidden tool among its few matches for a looser request: %s", async (query, expected) => {
    expect(names((await found(bridgeFor(FULL_CHIEF), query)).matches)).toContain(expected);
  });

  it("matches on words, not meaning: a request that shares none with any tool gets the names instead", async () => {
    // A known limit of a lexical search: create_trigger is what "nudge me" wants, but no word of it is in any tool.
    const payload = await found(bridgeFor(FULL_CHIEF), "nudge me tomorrow at 9");
    expect(payload.matches).toEqual([]);
    expect(payload.next).toContain("create_trigger");
  });

  it("puts a tool asked for by its exact name first, with what the unbridged turn would have listed: its name, its one-line description and its full input schema", async () => {
    for (const { profile: turn } of everyProfile()) {
      const tools = availableTools(turn) as BridgeTool[];
      const bridge = createToolBridge(tools);
      for (const hidden of bridge.hidden) {
        const match = (await found(bridge, hidden.name)).matches[0]!;
        const listed = tools.find((tool) => tool.name === hidden.name)!;
        // The description carries the rules a bot must follow (end the turn,
        // never claim success, call only when asked), so it is not shortened;
        // the schema is this turn's own, a Chief-only parameter left out
        // where the turn's list leaves it out. Nothing else rides along.
        expect(JSON.stringify(match), hidden.name).toBe(JSON.stringify({ name: listed.name, description: listed.description, inputSchema: listed.inputSchema }));
      }
      // every catalog description is one line already
      for (const tool of tools) expect(tool.description, tool.name).not.toMatch(/[\r\n]/);
    }
  });

  it("says how to run a match", async () => {
    expect((await found(bridgeFor(FULL_CHIEF), "list my routines")).next).toContain(`${USE_TOOL}({ "name": `);
  });

  it("never answers with more than a model should be handed, so no schema is cut short", async () => {
    // 24,000 characters is where the proxy starts cutting a result
    // (agents-result.ts), and a schema cut in half is not a schema.
    // The cap applies from the second match on and the first is always
    // whole, so the largest single definition is what could break it.
    for (const { name, profile: turn } of everyProfile()) {
      const bridge = createToolBridge(availableTools(turn) as BridgeTool[]);
      expect(Math.max(...bridge.hidden.map((tool) => JSON.stringify(tool).length)), name).toBeLessThan(20_000);
    }
    const bridge = bridgeFor(FULL_CHIEF);
    for (const query of ["routine schedule cron timezone interval", "team setup bots models rooms", "propose change profile model routine"]) {
      const answer = await bridge.find({ query });
      expect(JSON.parse(answer.text).matches.length, query).toBe(FIND_MATCHES_MAX);
      expect(answer.text.length, query).toBeLessThan(24_000);
    }
  });

  it("never returns a tool outside this turn's profile", async () => {
    const plain = bridgeFor();
    const allowed = new Set(names(plain.hidden));
    for (const query of ["create a new specialist bot", "delete a teammate", "set up the team", "retry a failed thread", "share a computer", "save a skill", "send a voice note", ...CHIEF_ONLY, "skill_manage", "shared_computer", "send_voice_note", "vm_exec"]) {
      const answer = await plain.find({ query });
      const matches = answer.isError ? [] : (JSON.parse(answer.text) as FindPayload).matches;
      for (const match of matches) expect(allowed.has(match.name), `${query} → ${match.name}`).toBe(true);
    }
    // and a Cloud home, which has no Local VM, cannot find its shell
    expect(names((await found(bridgeFor({ cloudHome: true }), "run a shell command in the VM")).matches)).not.toContain("vm_exec");
    expect(names((await found(bridgeFor(), "run a shell command in the VM")).matches)).toContain("vm_exec");
  });

  it("points at the tool list for a tool that is already in it", async () => {
    for (const listed of ["post_to_room", "list_bots", "select_computer"]) {
      const answer = await bridgeFor().find({ query: listed });
      expect(answer.isError).toBeFalsy();
      expect(answer.text).toBe(`${listed} is in your tool list: call it directly.`);
    }
  });

  it("says so when nothing matches, with the names there are", async () => {
    const bridge = bridgeFor();
    const payload = await found(bridge, "zzzqqq xylophone");
    expect(payload.matches).toEqual([]);
    expect(payload.next).toContain("Nothing matched");
    expect(payload.next).toContain(bridge.hidden[0]!.name);
  });

  it.each([[undefined], [{}], [{ query: "" }], [{ query: "   " }], [{ query: 7 }], [{ query: "x".repeat(1_001) }], ["routines"]])("fails a search that could not be made, with how to search: %j", async (args) => {
    const answer = await bridgeFor().find(args);
    expect(answer.text).toContain(`${FIND_TOOL} needs { "query": `);
    // a failed call, so it never reads as progress (server/runtime/tree.ts)
    expect(answer.isError).toBe(true);
  });
});

describe("use_tool", () => {
  it("hands a hidden tool's call on as it came", () => {
    const routed = bridgeFor().use({ name: "session_search", arguments: { query: "pricing audit", limit: 5 } });
    expect(routed).toEqual({ name: "session_search", arguments: { query: "pricing audit", limit: 5 } });
    // a tool that takes nothing may be called with no arguments at all
    expect(bridgeFor().use({ name: "list_triggers" })).toEqual({ name: "list_triggers", arguments: {} });
    expect(bridgeFor().use({ name: "list_triggers", arguments: null })).toEqual({ name: "list_triggers", arguments: {} });
  });

  it("is neither stricter nor looser than a direct call: the tool reads its own arguments", () => {
    // What a schema would refuse and the tool takes on purpose
    // (normalizeScheduleInput in agents-call.ts): a schedule sent as text,
    // "Daily", a short weekday. And what the tool, or the harness behind
    // it, refuses itself: a wrong type, a missing field, a parameter only
    // a Chief has.
    for (const args of [
      { name: "create_trigger", arguments: { name: "Brief", instructions: "Summarize.", schedule: JSON.stringify({ type: "Daily", time: "09:00" }) } },
      { name: "create_trigger", arguments: { name: "Brief", instructions: "Summarize.", schedule: { type: "weekly", time: "09:00", weekdays: ["mon"] } } },
      { name: "session_read", arguments: { thread_id: 42, extra: true } },
      { name: "propose_profile", arguments: { title: "Lead", reason: "asked", for_bot_id: "bot-other" } },
      { name: "memory_update", arguments: { action: "forget" } },
    ]) {
      expect(bridgeFor().use(args), JSON.stringify(args)).toEqual(args);
    }
  });

  it("names a tool outside this turn's profile for the front end to refuse as it refuses a direct call", () => {
    // No answer of its own: the proxy's one unknown-tool check rejects it,
    // in the same words as a direct call.
    for (const name of ["made_up", "create_bot", "skill_manage", "shared_computer", "send_voice_note", "create_options_card", FIND_TOOL, USE_TOOL]) {
      expect(bridgeFor().use({ name, arguments: { anything: true } }), name).toEqual({ name, arguments: { anything: true } });
    }
  });

  it("runs a listed tool too", () => {
    const remember = { name: "memory_update", arguments: { action: "append", text: "The deploy script lives in scripts/." } };
    expect(bridgeFor().use(remember)).toEqual(remember);
    const hand = { name: "coordinate_bots", arguments: { bot_ids: ["bot-helper"], message: "please review the patch" } };
    expect(bridgeFor().use(hand)).toEqual(hand);
  });

  it("sends an outward action back to its own name instead of running it", () => {
    for (const [options, name, args] of [
      [{}, "post_to_room", { group_id: "room-1", message: "Shipped." }],
      [{ voice: true }, "send_voice_note", { text: "Good morning." }],
    ] as const) {
      const routed = bridgeFor(options).use({ name, arguments: args });
      const answer = (routed as { answer: { text: string; isError?: boolean } }).answer;
      expect(answer, name).toMatchObject({ isError: true });
      expect(answer.text, name).toContain(`${name} is in your tool list`);
      expect(answer.text, name).toContain("Nothing was run");
    }
  });

  it.each([
    [undefined], [{}], [{ name: "" }], [{ name: "  " }], [{ name: 7 }], [{ name: "list_triggers", arguments: [1] }],
    [{ name: "list_triggers", arguments: "{}" }], [{ name: "list_triggers", arguments: 5 }], ["list_triggers"],
  ])("answers a call that is not the shape of one with the shape it needs: %j", (args) => {
    const routed = bridgeFor().use(args);
    const answer = (routed as { answer: { text: string; isError?: boolean } }).answer;
    expect(answer).toMatchObject({ isError: true });
    expect(answer.text).toContain(`${USE_TOOL} needs { "name": `);
  });

  it("answers only for its own two names: any other call is left exactly as it came", async () => {
    const bridge = bridgeFor();
    for (const name of ["post_to_room", "list_triggers", "create_bot", "made_up"]) expect(await bridge.route(name, { anything: true }), name).toBeUndefined();
    expect(await bridge.route(FIND_TOOL, { query: "what routines do I have" })).toHaveProperty("answer");
    expect(await bridge.route(USE_TOOL, { name: "list_triggers" })).toEqual({ name: "list_triggers", arguments: {} });
    expect(await bridge.route(USE_TOOL, { name: "create_bot", arguments: {} })).toEqual({ name: "create_bot", arguments: {} });
  });
});

describe("seeing through a bridged call", () => {
  it("tells a gate which tool a use_tool call names", () => {
    expect(bridgedCallTarget(USE_TOOL, { name: "vm_exec", arguments: { command: "true" } })).toBe("vm_exec");
    // nothing to judge: another call, or a use_tool that names no tool
    for (const [name, args] of [
      ["vm_exec", { command: "true" }], [FIND_TOOL, { query: "vm_exec" }], ["list_bots", { name: "vm_exec" }],
      [USE_TOOL, {}], [USE_TOOL, { name: "" }], [USE_TOOL, { name: 7 }], [USE_TOOL, undefined], [USE_TOOL, "vm_exec"],
    ] as const) expect(bridgedCallTarget(name, args), `${name} ${JSON.stringify(args)}`).toBeUndefined();
  });

  const isTool = (name: string) => ["list_triggers", "vm_exec", "post_to_room"].includes(name);

  it("names a bridged call after the tool it ran, in the engine's own spelling", () => {
    const args = { name: "list_triggers", arguments: {} };
    for (const prefix of ["", "mcp__agents__", "agents__", "agents_"]) {
      // from the arguments themselves, and from the preview a driver makes of them
      expect(bridgedCallTitle(`${prefix}use_tool`, args, isTool), prefix).toBe(`${prefix}list_triggers`);
      expect(bridgedCallTitle(`${prefix}use_tool`, toolDetailPreview(args), isTool), prefix).toBe(`${prefix}list_triggers`);
      expect(bridgedCallTitle(`${prefix}use_tool`, JSON.stringify(args), isTool), prefix).toBe(`${prefix}list_triggers`);
    }
  });

  it("still names it when the preview was cut short after the name, and leaves it alone when the name itself was cut off", () => {
    const long = "x".repeat(8_000);
    const nameFirst = toolDetailPreview({ name: "vm_exec", arguments: { command: long } })!;
    expect(nameFirst).toContain("[… preview shortened]");
    expect(() => JSON.parse(nameFirst)).toThrow();
    expect(bridgedCallTitle("mcp__agents__use_tool", nameFirst, isTool)).toBe("mcp__agents__vm_exec");
    // Arguments first, in a call this large, and the preview ends before the
    // tool's name: the call keeps the name it came with. A name inside the
    // arguments is not the tool's, and is not taken for it.
    const nested = toolDetailPreview({ arguments: { name: "post_to_room", command: long }, name: "vm_exec" })!;
    expect(nested).not.toContain('"vm_exec"');
    expect(bridgedCallTitle("mcp__agents__use_tool", nested, isTool)).toBe("mcp__agents__use_tool");
    // the same call small enough to be kept whole is named, whichever key came first
    expect(bridgedCallTitle("mcp__agents__use_tool", toolDetailPreview({ arguments: { name: "post_to_room", command: "true" }, name: "vm_exec" }), isTool)).toBe("mcp__agents__vm_exec");
  });

  it("leaves a title that names no server alone when asked to: a plain use_tool could be any server's", () => {
    const args = { name: "list_triggers" };
    expect(bridgedCallTitle("use_tool", args, isTool)).toBe("list_triggers");
    expect(bridgedCallTitle("use_tool", args, isTool, false)).toBe("use_tool");
    for (const prefix of ["mcp__agents__", "agents__", "agents_"]) expect(bridgedCallTitle(`${prefix}use_tool`, args, isTool, false), prefix).toBe(`${prefix}list_triggers`);
  });

  it("leaves every other name as it came", () => {
    // not use_tool, not the agents server's, or naming nothing the catalog has
    for (const [title, input] of [
      ["mcp__agents__list_triggers", {}],
      ["mcp__agents__find_tool", { query: "list_triggers" }],
      ["mcp__whop__use_tool", { name: "list_triggers" }],
      ["whop_use_tool", { name: "list_triggers" }],
      ["mcp__agents__use_tool", { name: "made_up" }],
      ["mcp__agents__use_tool", { name: "use_tool" }],
      ["mcp__agents__use_tool", { arguments: { name: "list_triggers" } }],
      ["mcp__agents__use_tool", undefined],
      ["mcp__agents__use_tool", "not json"],
      ["Bash", { name: "list_triggers" }],
    ] as const) expect(bridgedCallTitle(title, input, isTool), `${title} ${JSON.stringify(input)}`).toBe(title);
  });

  it("starts an agents server unbridged for a mount whose selection matches the name in the call", () => {
    const bridged = { command: "node", args: ["agents-proxy.js"], env: { OMB_BOT_ID: "bot-1", [TOOL_BRIDGE_ENV]: "1" } };
    expect(unbridgedServer(bridged)).toEqual({ command: "node", args: ["agents-proxy.js"], env: { OMB_BOT_ID: "bot-1", [TOOL_BRIDGE_ENV]: "0" } });
    // the turn's own integration is not touched
    expect(bridged.env[TOOL_BRIDGE_ENV]).toBe("1");
    // nothing to do: already unbridged, another server, or one with no environment
    const off = { command: "node", env: { [TOOL_BRIDGE_ENV]: "0" } };
    const other = { command: "npx", args: ["some-server"], env: { TOKEN: "t" } };
    const bare: { command: string; env?: Record<string, string> } = { command: "npx" };
    expect(unbridgedServer(off)).toBe(off);
    expect(unbridgedServer(other)).toBe(other);
    expect(unbridgedServer(bare)).toBe(bare);
  });
});
