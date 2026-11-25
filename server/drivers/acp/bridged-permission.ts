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
  | { kind: "reject" }
  | { kind: "find" }
  | { kind: "use"; toolCall: ToolCall };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** A name with every run of separators as one underscore, in lower case. */
const plain = (text: string) => text.toLowerCase().replace(/[._:/-]+/gu, "_");

/** Recorded on native Antigravity 1.5.14 and 1.5.16: `name` mcp_agents_<tool>, `title` Run mcp_agents_<tool>. */
const RECORDED = /^mcp_agents_([\w.-]+)$/u;
/** Any spelling that names an agents bridge tool, with any separator: the native CLI's own rename of a server it
 * registers again in one process (mcp_agents_<hex>_use_tool), Claude's mcp__agents__, a later release's mcp.agents.
 * Matched whole, so another server's find_tool is not one. */
const BRIDGE_SPELLING = /^(?:mcp[._:/-]{1,2}agents[._:/-]{1,2}(?:[0-9a-f]{4,}[._:/-])?|agents[._:/-]{1,2})?(?:use_tool|find_tool)$/iu;

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
  // A mounted server's own tool, mcp_<server>_<tool> with any separator: neither its name nor its input is the agents server's.
  if (names.length > 0 && names.every((name) => others.some((server) => plain(name).startsWith(`mcp_${plain(server)}_`)))) return { kind: "ordinary" };
  const recorded = names.map((name) => RECORDED.exec(name)?.[1]);
  const byName = names.some((name) => BRIDGE_SPELLING.test(name));
  if (!byName) {
    // A direct agents tool, in any separator: mcp.agents.attach_file is the same call as mcp_agents_attach_file.
    const direct = names.length > 0 && names.every((name) => { const tool = /^mcp_agents_(.+)$/u.exec(plain(name))?.[1]; return tool !== undefined && catalog.has(tool); });
    if (direct) return { kind: "ordinary" };
    const input = record(toolCall.rawInput) ? toolCall.rawInput : {};
    const shaped = typeof input.name === "string" && catalog.has(input.name) && (input.arguments == null || record(input.arguments));
    return shaped ? { kind: "refuse" } : { kind: "ordinary" };
  }
  const tool = recorded[0];
  const agreed = names.length > 0 && recorded.every((name) => name === tool) && (tool === USE_TOOL || tool === FIND_TOOL);
  if (!agreed || toolCall.kind !== "other") return { kind: "refuse" };
  if (tool === FIND_TOOL) return { kind: "find" };
  const input = record(toolCall.rawInput) ? toolCall.rawInput : {};
  const inner = typeof input.name === "string" && input.name.trim() ? input.name : undefined;
  if (!inner) return { kind: "reject" };
  return {
    kind: "use",
    toolCall: {
      ...toolCall,
      rawInput: record(input.arguments) ? input.arguments : {},
      title: `Run mcp_agents_${inner}`,
    },
  };
}

/** How the driver answers a bridged request itself, with no card: find_tool allowed once, a refused spelling rejected
 * with a note (the release then falls back), a recorded-spelling use_tool that names no tool rejected alone, and a
 * use_tool that offers no allow_once cancelled, since no answer to its card could allow it.
 * `end` ends the turn: after a refusal, or when the agent offered no option to answer with. */
export function bridgedAlone(permission: BridgedPermission, optionFor: (want: "allow" | "reject") => string | null, agent: string):
  { optionId: string | null; missing?: "allow" | "reject"; note?: string; end: boolean } | undefined {
  if (permission.kind === "use") return optionFor("allow") ? undefined : { optionId: null, missing: "allow", end: true };
  if (permission.kind === "reject") { const optionId = optionFor("reject"); return { optionId, ...(optionId ? {} : { missing: "reject" as const }), end: !optionId }; }
  if (permission.kind !== "refuse" && permission.kind !== "find") return undefined;
  const want = permission.kind === "find" ? "allow" : "reject";
  const optionId = optionFor(want);
  return {
    optionId,
    ...(optionId ? {} : { missing: want }),
    ...(permission.kind === "refuse" ? { note: `${agent} asked to run an agents tool through the tool bridge in a form this version does not know, so it was refused.` } : {}),
    end: permission.kind === "refuse" || !optionId,
  };
}
