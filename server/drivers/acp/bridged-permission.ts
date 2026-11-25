// How an ACP permission request is judged on a turn whose agents tools go through the tool bridge.
// Security invariant: a bridged use_tool is approved as the tool it names, with that tool's own input, and never for
// longer than once; a request that may be an agents bridge call but is not in a spelling recorded from the native
// Antigravity CLI is refused, never approved as some other tool.
import { OWN_APPS_SERVER } from "../../../shared/own-apps.ts";
import { FIND_TOOL, USE_TOOL } from "../agents-bridge.ts";

type ToolCall = { name?: unknown; title?: unknown; kind?: unknown; rawInput?: unknown; [key: string]: unknown };

export type BridgedPermission =
  | { kind: "ordinary" }
  | { kind: "refuse" }
  | { kind: "find" }
  | { kind: "use"; toolCall: ToolCall };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Recorded on native Antigravity 1.5.14 and 1.5.16: `name` mcp_agents_<tool>, `title` Run mcp_agents_<tool>. */
const RECORDED = /^mcp_agents_([\w.-]+)$/u;
/** Any spelling that names an agents bridge tool, the native CLI's own rename of a server it registers again in one
 * process (mcp_agents_<hex>_use_tool) among them. Matched whole, so another server's find_tool is not one. */
const BRIDGE_SPELLING = /^(?:mcp_agents_(?:[0-9a-f]{4,}_)?|mcp__agents__|agents__|agents_)?(?:use_tool|find_tool)$/iu;

/** The request's tool names: its `name`, and its `title` without the CLI's "Run ". */
function namesOf(toolCall: ToolCall): string[] {
  const names: string[] = [];
  if (typeof toolCall.name === "string" && toolCall.name) names.push(toolCall.name);
  if (typeof toolCall.title === "string" && toolCall.title) names.push(toolCall.title.replace(/^Run /u, ""));
  return names;
}

/** The names of the turn's MCP servers other than the agents server, as turnStdioMcpServers mounts them. */
export function otherMcpServers(integrations: { custom?: Record<string, unknown>; [key: string]: unknown } | undefined): string[] {
  const builtIn: Array<[string, string]> = [["composio", "composio"], ["composioOwn", OWN_APPS_SERVER], ["browser", "browser"], ["data", "data"],
    ["email", "email"], ["device", "device"], ["localComputer", "computer"]];
  return [...builtIn.filter(([key]) => integrations?.[key]).map(([, name]) => name), ...Object.keys(integrations?.custom ?? {})].filter((name) => name !== "agents");
}

/** `catalog` holds every agents tool name, the hidden ones among them; `others`, the turn's other MCP servers. */
export function bridgedPermission(toolCall: ToolCall, bridged: boolean, catalog: ReadonlySet<string>, others: readonly string[] = []): BridgedPermission {
  if (!bridged) return { kind: "ordinary" };
  const names = namesOf(toolCall);
  const recorded = names.map((name) => RECORDED.exec(name)?.[1]);
  const byName = names.some((name) => BRIDGE_SPELLING.test(name));
  if (!byName) {
    const direct = names.length > 0 && recorded.every((tool) => tool !== undefined && catalog.has(tool));
    // A mounted server's own tool, by the CLI's mcp_<server>_<tool>: its input says nothing about the agents server.
    const elsewhere = names.length > 0 && names.every((name) => others.some((server) => name.startsWith(`mcp_${server}_`)));
    if (direct || elsewhere) return { kind: "ordinary" };
    const input = record(toolCall.rawInput) ? toolCall.rawInput : {};
    const shaped = typeof input.name === "string" && catalog.has(input.name) && (input.arguments === undefined || record(input.arguments));
    return shaped ? { kind: "refuse" } : { kind: "ordinary" };
  }
  const tool = recorded[0];
  const agreed = names.length > 0 && recorded.every((name) => name === tool) && (tool === USE_TOOL || tool === FIND_TOOL);
  if (!agreed || toolCall.kind !== "other") return { kind: "refuse" };
  if (tool === FIND_TOOL) return { kind: "find" };
  const input = record(toolCall.rawInput) ? toolCall.rawInput : {};
  const inner = typeof input.name === "string" && input.name.trim() ? input.name : undefined;
  return {
    kind: "use",
    toolCall: {
      ...toolCall,
      rawInput: record(input.arguments) ? input.arguments : {},
      ...(inner ? { title: `Run mcp_agents_${inner}` } : {}),
    },
  };
}

/** How the driver answers a bridged request itself, with no card: find_tool allowed once, a refused spelling rejected.
 * `end` ends the turn: after a refusal, or when the agent offered no option to answer with. */
export function bridgedAlone(permission: BridgedPermission, optionFor: (want: "allow" | "reject") => string | null, agent: string):
  { optionId: string | null; missing?: "allow" | "reject"; note?: string; end: boolean } | undefined {
  if (permission.kind !== "refuse" && permission.kind !== "find") return undefined;
  const want = permission.kind === "find" ? "allow" : "reject";
  const optionId = optionFor(want);
  return {
    optionId,
    ...(optionId ? {} : { missing: want }),
    ...(permission.kind === "refuse" ? { note: `${agent} asked to run an agents tool through the tool bridge in a form this version does not know, so it was refused` } : {}),
    end: permission.kind === "refuse" || !optionId,
  };
}
