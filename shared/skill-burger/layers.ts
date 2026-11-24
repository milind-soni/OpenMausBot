// A run as burger layers: one per real step a bot took for the person's last ask (a command that changed something, an
// app action, a file it wrote, a page it opened). Looking around (reads of files, listings, snapshots, searches for
// tools) is not a layer, and a failed attempt a later call of the same tool replaced is dropped as a retry.
import { connectorCallsIn } from "../outbound.ts";
import { isReadOnlyAction } from "../connector-scopes.ts";
import { isConnectedAppsServer } from "../own-apps.ts";
import { parseRunCommand } from "../run-command.ts";
import { nameIsCommand } from "../tool-name.ts";
import { PLAIN_APP_TOOL } from "./apps.ts";

export type LayerKind = "shell" | "app" | "browser" | "file" | "computer" | "ai" | "decide";
/** Where a step happens: a connected app, the browser, the bot's own computer, a cloud computer (VM), or the person's own computer. */
export type LayerWhere = "app" | "browser" | "bot" | "vm" | "yourComputer";
export type LayerStatus = "running" | "done" | "failed";

/** The few message fields a run is read from: the same on the client and the server. */
export interface RunMessage {
  id: string;
  role: string;
  kind?: string;
  text?: string;
  tool?: { name: string; ok?: boolean; summary?: string; input?: string; output?: string } | null;
}

export interface BurgerLayer {
  /** The message id, with `#n` for the nth tool of one multi-app call. */
  id: string;
  messageId: string;
  kind: LayerKind;
  /** The connected app's lowercase slug (gmail), for app layers. */
  app?: string;
  /** What replays it: a Composio slug (GMAIL_SEND_EMAIL), a plain app tool (gmail.search_emails), or the tool's name. */
  tool: string;
  /** Words for the line: the app action ("send email"), the command's label, a file or host name. */
  words: string;
  status: LayerStatus;
  /** A read: it fetched something and changed nothing. */
  read: boolean;
  /** Where it ran, so a replay runs it in the same place. */
  where: LayerWhere;
  /** Exact replays without AI; `ai` means the recorded call can't be repeated as is. */
  replay: "exact" | "ai";
  /** The parsed call: app arguments, {command, cwd}, {path, content} or {url}. */
  args?: Record<string, unknown>;
  account?: string;
  output?: string;
}

const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const APP_META_TOOL = /^COMPOSIO_(?:SEARCH_TOOLS|GET_TOOL_SCHEMAS|MANAGE_CONNECTIONS|WAIT_FOR_CONNECTIONS?|CHECK_ACTIVE_CONNECTIONS?|INITIATE_CONNECTION|LIST_TOOLKITS)$/;
const APP_CODE_TOOL = /^COMPOSIO_(?:REMOTE_WORKBENCH|REMOTE_BASH_TOOL|PROXY_EXECUTE)$/;
const READ_WORDS = /^(?:batch |bulk )?(?:get|list|fetch|search|read|find|query|lookup|retrieve|view|describe|download)\b/;
const APP_SLUG = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
const TWO_WORD_APPS = new Set(["MICROSOFT_TEAMS", "GOOGLE_DRIVE", "GOOGLE_DOCS", "GOOGLE_SHEETS", "GOOGLE_CALENDAR", "ZOHO_MAIL", "ZOHO_CRM"]);
/** The app's own servers: coordination, computers, memory. Never a layer. */
const OWN_SERVERS = new Set(["agents", "phone", "device", "dweb", "ogb", "data", "memory", "permission"]);
/** A desktop the bot drives: its cloud computer, or the person's own computer. */
const COMPUTER_SERVERS: Record<string, LayerWhere> = { computer: "vm", localComputer: "yourComputer" };
/** Looking at a desktop changes nothing: never a layer. */
const COMPUTER_LOOK = /^(?:screenshot|get_screen_size|exec_status|move|wait|zoom|cursor_position|list_[a-z_]+|read_[a-z_]+|get_[a-z_]+)$/;
const FILE_WRITE = new Set(["Write", "write_file", "create_file"]);
const FILE_EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit", "edit", "apply_patch", "str_replace_based_edit_tool"]);
const BROWSER_OPEN = /(?:^|_)(?:navigate|open|open_url|goto|tab_new)$/;
const BROWSER_LOOK = /(?:^|_)(?:snapshot|screenshot|read|get_text|status|tabs|wait|check|console|network|close|evaluate_read)$/;
/** A status row the app writes as an activity: a lowercase word, a colon, then words, never a tool name. */
const STATUS_ROW = /^[a-z]+: \S/;
/** An input the driver clipped, or a value the server masked: the call can't be repeated as recorded. */
const CLIPPED = /\[(?:additional data|large content|binary content) omitted\]|••••••|«redacted \d+ chars»/;

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const sentence = (words: string) => words.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();

/** GMAIL_SEND_EMAIL → app gmail, words "send email". */
function slugParts(slug: string): { app: string; words: string } {
  const tokens = slug.split("_").filter(Boolean);
  const two = tokens.length > 2 ? `${tokens[0]}_${tokens[1]}` : "";
  const appTokens = TWO_WORD_APPS.has(two) ? 2 : 1;
  return { app: tokens.slice(0, appTokens).join("").toLowerCase(), words: sentence(tokens.slice(appTokens).join(" ")) };
}

/** The server and bare tool of an MCP name (mcp__composio__GMAIL_SEND_EMAIL); a bare name has no server. */
function splitName(name: string): { server: string | null; bare: string } {
  if (!name.startsWith("mcp__")) return { server: null, bare: name };
  const [, server = "", ...rest] = name.split("__");
  return { server, bare: rest.join("__") };
}

function appLayer(base: Omit<BurgerLayer, "kind" | "app" | "tool" | "words" | "read" | "replay" | "args" | "where">, slug: string, args: unknown, clipped: boolean, account?: string): RawLayer | null {
  if (APP_META_TOOL.test(slug)) return null;
  const { app, words } = slugParts(slug);
  const code = APP_CODE_TOOL.test(slug);
  return {
    ...base, kind: code ? "ai" : "app", app: code ? undefined : app, tool: slug, words: code ? "run code" : words,
    read: !code && (isReadOnlyAction(slug) || READ_WORDS.test(words)), replay: code || clipped || !isRecord(args) ? "ai" : "exact",
    ...(isRecord(args) ? { args } : {}), ...(account ? { account } : {}),
  };
}

/** The marker in a Skill Burger run's step rows: their input is {"skillBurgerRun": run, "name": …, "step": …}. */
export const RUN_STEP_MARK = "skillBurgerRun";
export const isRunStep = (input: string | undefined): boolean => Boolean(input?.includes(`"${RUN_STEP_MARK}"`));

/** The layers one tool message stands for: none, one, or one per app of a multi-app call. */
export function layersOf(message: RunMessage, live: ReadonlySet<string> = new Set()): BurgerLayer[] {
  const { server, bare } = splitName(message.tool?.name ?? "");
  return layersIn(message, live).map((layer) => ({ ...layer, where: layer.where ?? whereOf(layer, server, bare) }));
}

/** Where a layer ran, when its kind says it: an app, the browser, a VM command, or else the bot's own computer. */
function whereOf(layer: Omit<BurgerLayer, "where"> & { where?: LayerWhere }, server: string | null, bare: string): LayerWhere {
  if (layer.kind === "app") return "app";
  if (layer.kind === "browser" || /browser/i.test(server ?? "") || /^(?:agent_)?browser_/.test(bare)) return "browser";
  if (bare === "vm_exec") return "vm";
  if (layer.kind === "ai" && layer.tool.startsWith("COMPOSIO_")) return "app";
  return "bot";
}

type RawLayer = Omit<BurgerLayer, "where"> & { where?: LayerWhere };

function layersIn(message: RunMessage, live: ReadonlySet<string>): RawLayer[] {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool?.name) return [];
  // The app's own status rows ("recovery: …", "notice: …") ride in activity messages too; they are not steps.
  if (STATUS_ROW.test(tool.name)) return [];
  // A saved run's own steps are the burger already, not new steps to save.
  if (isRunStep(tool.input)) return [];
  const status: LayerStatus = tool.ok === false ? "failed" : tool.ok === undefined && live.has(message.id) ? "running" : "done";
  const base = { messageId: message.id, status, ...(tool.output ? { output: tool.output } : {}) };
  const input = parse(tool.input);
  const clipped = Boolean(tool.input && CLIPPED.test(tool.input));
  const { server, bare } = splitName(tool.name);
  const desk = server ? COMPUTER_SERVERS[server] : undefined;
  if (desk) {
    if (COMPUTER_LOOK.test(bare)) return [];
    if (bare === "exec" || bare === "run_command") {
      const full = text(input?.command);
      if (!full || !parseRunCommand(full)) return [];
      return [{ ...base, id: message.id, kind: "shell", where: desk, tool: `${server}.exec`, words: shellLine(full), read: false, replay: clipped ? "ai" : "exact", args: { command: full } }];
    }
    const url = text(input?.url);
    if (bare === "open_url" && url) {
      let host = url;
      try { host = new URL(url).host || url; } catch { /* keep the text */ }
      return [{ ...base, id: message.id, kind: "browser", where: desk, tool: `${server}.open_url`, words: host, read: false, replay: clipped ? "ai" : "exact", args: { url } }];
    }
    // Clicks, typing, keys, scrolls and drags on a desktop: done again by the AI, which looks at the screen first.
    return [{ ...base, id: message.id, kind: "computer", where: desk, tool: `${server}.${bare}`, words: sentence(bare), read: false, replay: "ai", ...(input ? { args: input } : {}) }];
  }
  if (bare === "vm_exec") {
    // A command on the bot's own VM or VPS desktop.
    const full = text(input?.command);
    if (!full || !parseRunCommand(full)) return [];
    return [{ ...base, id: message.id, kind: "shell", where: "vm", tool: "vm_exec", words: shellLine(full), read: false, replay: clipped ? "ai" : "exact", args: { command: full } }];
  }
  if (server && OWN_SERVERS.has(server)) return [];

  if (bare === MULTI_EXECUTE) {
    const calls = connectorCallsIn(MULTI_EXECUTE, input ?? {});
    return calls.flatMap((call, index) => {
      const layer = appLayer({ ...base, id: calls.length > 1 ? `${message.id}#${index}` : message.id }, call.slug, call.arguments, clipped || !input, call.account);
      return layer ? [layer] : [];
    });
  }
  const plain = PLAIN_APP_TOOL.exec(bare);
  if (plain && (!server || isConnectedAppsServer(server))) {
    return [{
      ...base, id: message.id, kind: "app", app: plain[1]!, tool: `${plain[1]}.${plain[2]}`, words: sentence(plain[2]!),
      read: /^(?:search|read|list|get|find|fetch)/.test(plain[2]!), replay: clipped || !input ? "ai" : "exact", ...(input ? { args: input } : {}),
    }];
  }
  if (APP_SLUG.test(bare) && (!server || isConnectedAppsServer(server))) {
    const layer = appLayer({ ...base, id: message.id }, bare, input, clipped);
    return layer ? [layer] : [];
  }
  if (/browser/i.test(server ?? "") || /^(?:agent_)?browser_/.test(bare)) {
    if (BROWSER_LOOK.test(bare)) return [];
    const url = text(input?.url);
    if (BROWSER_OPEN.test(bare) && url) {
      let host = url;
      try { host = new URL(url).host || url; } catch { /* keep the text */ }
      return [{ ...base, id: message.id, kind: "browser", tool: bare, words: host, read: false, replay: clipped ? "ai" : "exact", args: { url } }];
    }
    return [{ ...base, id: message.id, kind: "ai", tool: bare, words: sentence(bare.replace(/^(?:agent_)?browser_/, "")), read: false, replay: "ai", ...(input ? { args: input } : {}) }];
  }
  if (server && !isConnectedAppsServer(server)) {
    // Another MCP server the person added: an app step only its own engine can call.
    return [{ ...base, id: message.id, kind: "app", app: server.toLowerCase(), tool: tool.name, words: sentence(bare), read: /^(?:get|list|search|read|find|fetch|query)/i.test(bare), replay: "ai", ...(input ? { args: input } : {}) }];
  }
  if (FILE_WRITE.has(bare) || FILE_EDIT.has(bare)) {
    const path = text(input?.file_path) ?? text(input?.path) ?? text(input?.notebook_path);
    if (!path) return [{ ...base, id: message.id, kind: "ai", tool: bare, words: "edit files", read: false, replay: "ai" }];
    const content = typeof input?.content === "string" ? input.content : undefined;
    const exact = FILE_WRITE.has(bare) && content !== undefined && !clipped;
    return [{ ...base, id: message.id, kind: exact ? "file" : "ai", tool: bare, words: baseName(path), read: false, replay: exact ? "exact" : "ai", args: exact ? { path, content } : { path } }];
  }
  const command = text(tool.summary) ?? text(input?.command) ?? (nameIsCommand(tool.name) ? tool.name : undefined);
  if (command && (bare === "Bash" || bare === "shell" || bare === "vm_exec" || /^(?:exec_command|run_shell_command|bash|terminal)$/i.test(bare) || nameIsCommand(tool.name) || text(input?.command))) {
    const parsed = parseRunCommand(command);
    if (!parsed) return [];
    const full = text(input?.command) ?? command;
    const cwd = text(input?.cwd);
    return [{ ...base, id: message.id, kind: "shell", tool: bare === "vm_exec" ? "vm_exec" : "shell", words: shellLine(full), read: false, replay: clipped ? "ai" : "exact", args: { command: full, ...(cwd ? { cwd } : {}) } }];
  }
  return [];
}

function askIndex(messages: readonly RunMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user" && m.kind === "text" && m.text?.trim()) return i;
  }
  return -1;
}

/** The person's last ask, its first line. */
export function askOf(messages: readonly RunMessage[]): string | undefined {
  const index = askIndex(messages);
  if (index < 0) return undefined;
  const line = messages[index]!.text!.trim().split(/\r?\n/, 1)[0]!.trim();
  return line || undefined;
}

/** A command as its layer reads: its first line, cut at 60 characters. */
function shellLine(command: string): string {
  const line = command.trim().split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const sameStep = (a: BurgerLayer, b: BurgerLayer) => a.kind === b.kind && a.tool === b.tool && (a.app ?? "") === (b.app ?? "") && a.where === b.where;

/** Desktop actions in a row on one computer are one layer: "click, type text, key press", done again by the AI. */
function joinDesktop(layers: BurgerLayer[]): BurgerLayer[] {
  const out: BurgerLayer[] = [];
  for (const layer of layers) {
    const last = out[out.length - 1];
    if (layer.kind === "computer" && last?.kind === "computer" && last.where === layer.where && last.status !== "failed" && layer.status !== "failed") {
      const actions = [...(Array.isArray(last.args?.actions) ? last.args.actions as unknown[] : [{ tool: last.tool, ...last.args }]), { tool: layer.tool, ...layer.args }];
      const words = [...new Set([...last.words.split(", "), layer.words])].join(", ");
      out[out.length - 1] = { ...last, id: layer.id, status: layer.status, words, args: { actions } };
    } else out.push(layer);
  }
  return out;
}

/** The run since the person's last ask, as layers. */
export function burgerLayers(messages: readonly RunMessage[], live: ReadonlySet<string> = new Set()): BurgerLayer[] {
  const layers = messages.slice(askIndex(messages) + 1).flatMap((message) => layersOf(message, live));
  return joinDesktop(layers.filter((layer, index) => layer.status !== "failed" || !layers.slice(index + 1).some((later) => later.status !== "failed" && sameStep(layer, later))));
}

/** A burger shows for a run of two real steps or more. */
export const BURGER_MIN_LAYERS = 2;
