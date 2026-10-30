// The agents tool bridge: a turn lists a few tools plus find_tool and use_tool, which runs a hidden one.
// Security invariant: a bridged call is never judged more permissively than the same call made directly.
// use_tool hands the name back to the proxy's one unknown-tool check and callTool path, and a tool judged
// by its name (an outbound tool, a tool selection, an engine's own rules) never runs through it.
import { isOutboundTool } from "../../shared/outbound.ts";
import { READ_ONLY_ANNOTATIONS } from "../agent-tool-policy.ts";
import { bm25Ranker } from "../mcp-directory.ts";
import { AGENTS_TOOL_ALIASES } from "../../shared/agents-tool-names.ts";
import type { Json } from "./agents-client.ts";

/** The proxy's switch: "1" lists through the bridge, anything else lists the whole catalog. */
export const TOOL_BRIDGE_ENV = "OMB_AGENTS_TOOL_BRIDGE";
export const FIND_TOOL = "find_tool";
export const USE_TOOL = "use_tool";

/** One tool as tools/list serializes it; a type alias because an interface does not satisfy the ranker's open record. */
export type BridgeTool = {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: unknown;
};

/** What a bridge tool answers itself, when it runs nothing. */
export interface BridgeAnswer {
  text: string;
  isError?: boolean;
}

/** What one bridge call comes to: the tool to run, or the answer to give. */
export type BridgeRoute = { name: string; arguments: Json } | { answer: BridgeAnswer };

/** The tools that stay listed: ones most turns need, or must reach without a detour to stay inside the
 * rules. Every tool the host counts as outbound is listed as well (calledByItsOwnName). */
export const BRIDGE_HOT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_options_card",
  "tool_result_read",
  "list_room_targets",
  "coordinate_bots",
  "list_bots",
  "list_rooms",
  "select_computer",
  "attach_file",
  "post_to_room",
  "request_credential",
  "request_sign_in",
  "fill_login",
  "send_voice_note",
  "memory_update",
]);

/** Matches per search; each carries its full input schema. */
export const FIND_MATCHES_MAX = 3;
/** Under the proxy's 24,000-character result cut, so no schema is cut in half; the first match is always whole. */
const FIND_CHARS_MAX = 20_000;
const QUERY_CHARS = 1_000;
/** Room for the hidden tools' names in find_tool's own description. */
export const BRIDGE_NAMES_MAX_CHARS = 1_200;
/** Room kept to say how many names were left out. */
const MORE_NAMES_CHARS = 24;

function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The agents server's prefix on its tools, per engine: Claude `mcp__agents__`, ACP `agents__`, the chat
 * runtime and Pi `agents_`, Codex none. */
const SERVER_PREFIXES = ["", "mcp__agents__", "agents__", "agents_"] as const;

/** Security: a tool the host classifies as outbound under any engine's spelling is always listed and never
 * run through use_tool. Derived from the classifier, so a new outbound tool cannot be hidden by omission. */
function calledByItsOwnName(name: string): boolean {
  return SERVER_PREFIXES.some((prefix) => isOutboundTool(`${prefix}${name}`));
}

/** The tool a use_tool call names, for a gate that judges a call by its name; undefined otherwise. */
export function bridgedCallTarget(name: string, args: unknown): string | undefined {
  const target = name === USE_TOOL && record(args) ? args.name : undefined;
  return typeof target === "string" && target.trim() ? target : undefined;
}

/** A call's name once seen: an agents use_tool naming a catalog tool reads as that tool, in the engine's
 * spelling. `input` may be a driver's cut JSON preview; a name past the cut keeps the original title.
 * `bare` false leaves a title with no server alone: a plain `use_tool` could be any server's. */
export function bridgedCallTitle(title: string, input: unknown, isCatalogTool: (name: string) => boolean, bare = true): string {
  const prefix = SERVER_PREFIXES.find((spelling) => title === `${spelling}${USE_TOOL}`);
  if (prefix === undefined || (prefix === "" && !bare)) return title;
  let args = input;
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
    } catch {
      // A cut preview is not JSON, but only its top-level keys sit at exactly two spaces.
      args = { name: /^ {2}"name": "([^"\\]+)",?$/m.exec(input)?.[1] };
    }
  }
  const inner = bridgedCallTarget(USE_TOOL, args);
  return inner !== undefined && isCatalogTool(inner) ? `${prefix}${inner}` : title;
}

/** Security: an agents server spec forced to list its whole catalog, for a mount whose tool selection
 * matches the name in the call. */
export function unbridgedServer<Spec extends { env?: Record<string, string> }>(server: Spec): Spec {
  return server.env && Object.hasOwn(server.env, TOOL_BRIDGE_ENV) && server.env[TOOL_BRIDGE_ENV] !== "0"
    ? { ...server, env: { ...server.env, [TOOL_BRIDGE_ENV]: "0" } }
    : server;
}

/** Whether a turn's agents integration was asked to bridge. A selection may still mount it unbridged,
 * so anything a turn is told on the strength of this must hold either way. */
export function agentsToolBridged(agents: { env?: Record<string, string | undefined> } | undefined): boolean {
  return agents?.env?.[TOOL_BRIDGE_ENV] === "1";
}

/** `a, b, c.` within maxChars, or `a, b, … and 12 more.` Names are never cut. */
function namesList(names: readonly string[], maxChars: number): string {
  if (!names.length) return "none.";
  let text = "";
  let shown = 0;
  for (const name of names) {
    const part = `${shown ? ", " : ""}${name}`;
    const last = shown === names.length - 1;
    if (text.length + part.length + (last ? 1 : MORE_NAMES_CHARS) > maxChars) break;
    text += part;
    shown += 1;
  }
  return shown < names.length ? `${text}${shown ? ", " : ""}… and ${names.length - shown} more.` : `${text}.`;
}

const FIND_USAGE = `${FIND_TOOL} needs { "query": "what you want to do, in a few words" }, for example "schedule a routine", or a tool's exact name.`;
const USE_USAGE = `${USE_TOOL} needs { "name": "the tool's exact name", "arguments": { ... } }, with arguments a JSON object as the tool's input schema describes it. Find the name and the schema with ${FIND_TOOL}.`;
const HOW_TO_RUN = `Run one with ${USE_TOOL}({ "name": "...", "arguments": { ... } }), with arguments that fit its inputSchema. Follow its description as you would for a tool in your list.`;

export interface ToolBridge {
  /** What tools/list answers: the hot tools in catalog order, then find_tool and use_tool. */
  readonly listed: readonly BridgeTool[];
  /** The rest of the profile, in catalog order: what find_tool searches. */
  readonly hidden: readonly BridgeTool[];
  find(args: unknown): Promise<BridgeAnswer>;
  use(args: unknown): BridgeRoute;
  /** A bridge tool's answer or the tool it runs; undefined for any other name, which is called as it came. */
  route(name: string, args: Json): Promise<BridgeRoute | undefined>;
}

/** The bridge over one turn's profile: `tools` is the whole of what the turn may call. */
export function createToolBridge(tools: readonly BridgeTool[]): ToolBridge {
  const profile = new Set(tools.map((tool) => tool.name));
  const hot = tools.filter((tool) => BRIDGE_HOT_TOOL_NAMES.has(tool.name) || calledByItsOwnName(tool.name));
  const hotNames = new Set(hot.map((tool) => tool.name));
  const hidden = tools.filter((tool) => !hotNames.has(tool.name));

  const listed: BridgeTool[] = [
    ...hot,
    {
      name: FIND_TOOL,
      description: `Find an OpenMausBot tool that is not in your tool list. Say what you want to do in a few words, or give the tool's name. Each match comes back with its description and exact input schema; run one with ${USE_TOOL}. Tools reached this way: ${namesList(hidden.map((tool) => tool.name), BRIDGE_NAMES_MAX_CHARS)}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "What you want to do, in a few words, or a tool's exact name." },
        },
        required: ["query"],
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    {
      name: USE_TOOL,
      description: `Run one OpenMausBot tool that ${FIND_TOOL} gave you, by its exact name, with its input as arguments. It runs exactly as if you had called it directly: the same permissions, limits and refusals apply, and its result comes back unchanged. Read the tool's description and input schema from ${FIND_TOOL} before the first call.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: `The tool's exact name, as ${FIND_TOOL} gave it.` },
          arguments: { type: "object", additionalProperties: true, description: `The tool's input, as the input schema ${FIND_TOOL} returned describes it. Leave out for a tool that takes none.` },
        },
        required: ["name"],
      },
    },
  ];
  const listedNames = new Set(listed.map((tool) => tool.name));

  async function find(args: unknown): Promise<BridgeAnswer> {
    const query = record(args) && typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > QUERY_CHARS) return { text: FIND_USAGE, isError: true };
    const named = Object.hasOwn(AGENTS_TOOL_ALIASES, query) ? AGENTS_TOOL_ALIASES[query]!.tools[0]! : query;
    if (listedNames.has(named)) return { text: `${named} is in your tool list: call it directly.` };
    const ranked = await bm25Ranker(named, hidden, FIND_MATCHES_MAX);
    const matches: Array<Pick<BridgeTool, "name" | "description" | "inputSchema">> = [];
    let chars = 0;
    for (const candidate of ranked.slice(0, FIND_MATCHES_MAX)) {
      // Security: only ever a tool of this turn's profile, whatever the ranker returns.
      const tool = hidden.find((entry) => entry.name === candidate.name);
      if (!tool) continue;
      const match = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
      const size = JSON.stringify(match).length;
      if (matches.length && chars + size > FIND_CHARS_MAX) break;
      matches.push(match);
      chars += size;
    }
    return { text: JSON.stringify(matches.length
      ? { matches, next: HOW_TO_RUN }
      : { matches, next: `Nothing matched. Try other words, or one of these names: ${namesList(hidden.map((tool) => tool.name), BRIDGE_NAMES_MAX_CHARS)} A tool in your tool list is called directly.` }) };
  }

  // Only the call's shape is checked here: the tool reads its own arguments, as on a direct call.
  function use(args: unknown): BridgeRoute {
    const name = record(args) && typeof args.name === "string" ? args.name : "";
    const input = record(args) ? args.arguments : undefined;
    if (!name.trim() || (input != null && !record(input))) return { answer: { text: USE_USAGE, isError: true } };
    // Security: a name outside the profile is passed on, so the proxy's one unknown-tool check refuses it
    // exactly as it would a direct call.
    if (profile.has(name) && calledByItsOwnName(name)) {
      return { answer: { text: `${name} is in your tool list: call it directly, not through ${USE_TOOL}. Nothing was run.`, isError: true } };
    }
    return { name, arguments: input ?? {} };
  }

  async function route(name: string, args: Json): Promise<BridgeRoute | undefined> {
    if (name === FIND_TOOL) return { answer: await find(args) };
    if (name === USE_TOOL) return use(args);
    return undefined;
  }

  return { listed, hidden, find, use, route };
}
