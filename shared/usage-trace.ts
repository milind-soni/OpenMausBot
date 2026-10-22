// Wire shapes of the usage trace view, shared by the server's builder and the renderer.
import { TOOL_NAMESPACE, toolSurfaceKind } from "./tool-surface.ts";

/** Who or what started a root. */
export type TraceSource = "person" | "owner" | "routine" | "bot" | "helper";

/** `ended`: the tool was still open when its turn ended. */
export type TraceStatus = "ok" | "error" | "interrupted" | "ended";

/** `partial`: the engine reported some token fields but not all; `unavailable`: none. Neither is ever shown as 0. */
export type TraceUsageStatus = "complete" | "partial" | "unavailable";

export interface TraceParent {
  threadId: string;
  turnId: string;
}

/** Input counts every prompt token, cache reads and writes included; reasoning is part of output. */
export interface TraceTokens {
  input: number;
  cachedInput: number;
  cacheWrite?: number;
  output: number;
  reasoning?: number;
}

export type TraceToolIcon =
  | "search" | "web" | "browser" | "computer" | "phone" | "files" | "terminal" | "memory" | "routine"
  | "page" | "widget" | "bots" | "plan" | "image" | "data" | "app" | "mcp" | "tool";

export interface TraceTool {
  kind: "tool";
  id: string;
  name: string;
  icon: TraceToolIcon;
  /** A connected app's toolkit slug, for its logo. */
  app?: string;
  /** The MCP server a tool came from, when it is not one of the app's own. */
  server?: string;
  /** One short, clipped, redacted line: the query, the page, the action. */
  detail?: string;
  startedAt: number;
  /** Absent while running, or when the engine gave no end: the tool is drawn as a point. */
  endedAt?: number;
  status: TraceStatus;
  error?: string;
  /** Who measured it: OMB's own tools are timed by the server on every engine. */
  timedBy: "engine" | "omb";
  running?: boolean;
}

export interface TraceStep {
  kind: "step";
  id: string;
  startedAt: number;
  endedAt?: number;
  tokens?: TraceTokens;
  contextTokens?: number;
  contextWindow?: number;
  /** This step's share of its turn's cost. */
  costUsd?: number | null;
  running?: boolean;
}

/** Consecutive uses of one kind of tool, folded into one row with a count and a total. */
export interface TraceGroup {
  kind: "group";
  id: string;
  icon: TraceToolIcon;
  app?: string;
  server?: string;
  name: string;
  count: number;
  errors: number;
  startedAt: number;
  endedAt?: number;
  running?: boolean;
  children: Array<TraceTool | TraceStep>;
}

export interface TraceTurn {
  kind: "turn";
  id: string;
  threadId: string;
  turnId?: string;
  botId: string;
  botName: string;
  model: string;
  driverKind: string;
  startedAt: number;
  endedAt?: number;
  /** False for turns recorded before timing existed: drawn as a point at their end. */
  timed: boolean;
  running?: boolean;
  status: TraceStatus;
  reason?: string;
  costUsd: number | null;
  costSource?: "reported" | "estimated";
  tokens: TraceTokens;
  usageStatus: TraceUsageStatus;
  contextTokens?: number;
  contextWindow?: number;
  children: TraceNode[];
}

export type TraceNode = TraceTurn | TraceStep | TraceTool | TraceGroup;

export interface TraceTotals {
  durationMs: number;
  costUsd: number | null;
  tokens: number;
  input: number;
  cachedInput: number;
  output: number;
  steps: number;
  tools: number;
  errors: number;
}

export interface TraceRootSummary extends TraceTotals {
  id: string;
  title: string;
  source: TraceSource;
  startedAt: number;
  endedAt: number;
  running: boolean;
  timed: boolean;
  bots: Array<{ id: string; name: string }>;
  /** Some turn reported no usage at all, or only part of it. */
  usageStatus: TraceUsageStatus;
}

export interface TraceList {
  from: string;
  to: string;
  totals: TraceTotals;
  roots: TraceRootSummary[];
  /** Offset of the next page, absent on the last. */
  next?: number;
}

export interface TraceDetail {
  root: TraceRootSummary;
  turns: TraceTurn[];
}

export function traceRootId(threadId: string, turnId: string): string {
  return `${encodeURIComponent(threadId)}~${encodeURIComponent(turnId)}`;
}

const SERVER_ICONS: Readonly<Record<string, TraceToolIcon>> = { phone: "phone", data: "data", dweb: "web", browser: "browser", computer: "computer" };
const OWN_SERVERS = new Set(["agents", "ogb", "composio", ...Object.keys(SERVER_ICONS)]);
const COMPOSIO_ACTION = /^([A-Z][A-Z0-9]+)_[A-Z0-9_]+$/;
const BUILT_IN_ICONS: ReadonlyArray<[RegExp, TraceToolIcon]> = [
  [/^(?:websearch|web_search|search_web|google_search|x_search|research)$/, "search"],
  [/^(?:webfetch|web_fetch|fetch|open_url|read_url|fetch_url)$/, "web"],
  [/^(?:bash|shell|terminal|run_command|execute|exec|vm_exec|computer_exec|run_shell_command|local_shell|killshell|bashoutput)$/, "terminal"],
  [/^(?:read|read_file|write|write_file|create_file|edit|multiedit|str_replace|apply_patch|notebookedit|delete|grep|glob|find|ls|list_files|attach_file|view|tool_result_read)$/, "files"],
  [/^(?:memory|remember|recall|memory_[a-z_]+|search_memory|save_memory|session_search|session_read)$/, "memory"],
  [/^(?:routine|routines|schedule|cron)(?:_[a-z_]+)?$|^[a-z_]*(?:routine|trigger)[a-z_]*$/, "routine"],
  [/^(?:publish_page|unpublish_page|[a-z_]*page_publish[a-z_]*|pages?_[a-z_]+)$/, "page"],
  [/^(?:show_html|show_widget|render_widget|show_chart|show_table|show_card|widget|[a-z_]*_card)$/, "widget"],
  [/^(?:coordinate_bots|ask_bots?|delegate|task|agent|assignment_status|send_to_bot|raise_escalation|select_computer|create_bot)$/, "bots"],
  [/^(?:(?:open|start|list|close|retry)_threads?|list_bots|list_rooms|list_room_targets|post_to_room|create_room|manage_room)$/, "bots"],
  [/^(?:phone|android|adb)(?:_[a-z_]+)?$/, "phone"],
  [/^(?:todowrite|update_plan|plan|think)$/, "plan"],
  [/^(?:generate_image|image_generation|imagegen|create_image)$/, "image"],
];

/** What a tool call should look like in a trace: an icon, and the app or MCP server it belongs to. */
export function traceToolLook(name: string): { icon: TraceToolIcon; app?: string; server?: string } {
  const server = /^mcp__(.+?)__/.exec(name)?.[1];
  const bare = name.replace(TOOL_NAMESPACE, "");
  const composio = COMPOSIO_ACTION.exec(bare);
  if (composio && composio[1] !== "COMPOSIO") return { icon: "app", app: composio[1]!.toLowerCase() };
  if (server === "composio" || composio) return { icon: "app" };
  const surface = toolSurfaceKind(name);
  if (surface) return { icon: surface };
  const lower = bare.toLowerCase();
  for (const [pattern, icon] of BUILT_IN_ICONS) if (pattern.test(lower)) return { icon };
  if (server && SERVER_ICONS[server]) return { icon: SERVER_ICONS[server]! };
  if (server && !OWN_SERVERS.has(server)) return { icon: "mcp", server };
  return { icon: "tool" };
}
