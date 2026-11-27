// A run as burger layers: one per real step a bot took for the person's last ask (a command that changed something, an
// app action, a file it wrote, a page it opened). Looking around (reads of files, listings, snapshots, searches for
// tools) is not a layer, and a failed attempt a later call of the same tool replaced is dropped as a retry.
import { connectorCallsIn } from "../outbound.ts";
import { isReadOnlyAction } from "../connector-scopes.ts";
import { isConnectedAppsServer } from "../own-apps.ts";
import { parseRunCommand } from "../run-command.ts";
import { nameIsCommand } from "../tool-name.ts";
import { PLAIN_APP_TOOL } from "./apps.ts";

export type LayerKind = "shell" | "app" | "browser" | "file" | "computer" | "ai" | "decide" | "delegate";
/** Where a step happens: a connected app, the browser, the bot's own computer, a cloud computer (VM), or the person's own computer. */
export type LayerWhere = "app" | "browser" | "bot" | "vm" | "yourComputer";
export type LayerStatus = "running" | "done" | "failed";

/** The few message fields a run is read from: the same on the client and the server. */
export interface RunMessage {
  id: string;
  role: string;
  kind?: string;
  text?: string;
  tool?: { name: string; ok?: boolean; summary?: string; input?: string; output?: string; itemId?: string; setup?: boolean } | null;
  /** On the app's own rows about teammates: who it is from, the thread it went to, the hand-off it answers. */
  from?: { botId?: string; name?: string } | null;
  threadRef?: { botId?: string; threadId?: string } | null;
  comm?: unknown;
  roomRequest?: { id: string; phase: string } | null;
  doneWhen?: string;
  handoff?: unknown;
}

/** One coordinate_bots call: who it went to, what it asked, and the hand-off each teammate got. */
export interface DelegateCall {
  bots: Array<{ id?: string; name: string }>;
  message: string;
  doneWhen?: string;
  rework?: boolean;
  consult?: boolean;
  requests: Array<{ name: string; botId?: string; requestId?: string }>;
}
/** What a teammate sent back for one hand-off. */
export interface DelegateReply { name: string; botId?: string; requestId: string; ok: boolean; text: string; round: number }
/** A delegation as one step: the calls of each round (the first sends the work, later ones send some of it back) and the
 * replies. The replies are this run's results, shown on the card; they are never saved into the workflow. */
export interface Delegation { rounds: DelegateCall[][]; replies: DelegateReply[] }

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
  /** Failed tries of this same step that this one replaced. */
  tries?: number;
  /** Something was read or looked at before this step in the run (a page, a file, a fetch). */
  afterRead?: boolean;
  /** A delegation: its rounds and replies. */
  delegation?: Delegation;
  /** The bot's own review of what came back, closing a run that handed work out. */
  review?: true;
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
const FILE_WRITE = new Set(["Write", "write", "write_file", "create_file"]);
const FILE_EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit", "edit", "apply_patch", "str_replace_based_edit_tool"]);
const BROWSER_OPEN = /(?:^|_)(?:navigate|open|open_url|goto|tab_new)$/;
const BROWSER_LOOK = /(?:^|_)(?:snapshot|screenshot|read|get_text|status|tabs|wait|check|console|network|close|evaluate_read)$/;
/** A status row the app writes as an activity: a lowercase word, a colon, then words, never a tool name. */
const STATUS_ROW = /^[a-z]+: \S/;
const COORDINATE = /(?:^|__)coordinate_bots$/;

/** A row the app wrote itself ("Sent to Kiwi", "Kiwi replied", "Resumed with …", a notice), never a tool the bot called.
 * Every engine tool row has the engine's item id; the app's rows have none, and its teammate rows also say where they
 * point. Read from the row's shape, never its words, which are in the person's language. */
export function isServerRow(message: RunMessage): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (tool.itemId) return false;
  return Boolean(message.threadRef || message.comm || message.roomRequest || message.handoff || message.doneWhen || tool.setup || (!tool.input && !tool.summary));
}

/** The unquoted output redirect of a command (`> notes.md`, `>> log.txt`, `cat > a.md <<EOF`), other than to /dev/…:
 * it writes a file, whatever program it runs. */
export function redirectTarget(command: string): string | null {
  return redirectOf(command)?.path ?? null;
}

function redirectOf(command: string): { path: string; append: boolean } | null {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === "\\" && quote !== "'") { i += 1; continue; }
    if ((char === "'" || char === '"') && (quote === null || quote === char)) { quote = quote ? null : char; continue; }
    if (quote || char !== ">") continue;
    const before = command[i - 1] ?? " ";
    if (/[0-9&>-]/.test(before) && before !== " ") continue;
    let j = i + 1;
    const append = command[j] === ">";
    if (append) j += 1;
    if (command[j] === "&" || command[j] === "(") continue;
    while (command[j] === " ") j += 1;
    const target = /^(?:"([^"]+)"|'([^']+)'|["']?([^\s"';|&]+))/.exec(command.slice(j));
    const path = target?.[1] ?? target?.[2] ?? target?.[3];
    if (path && !path.startsWith("/dev/")) return { path, append };
  }
  return null;
}

/** A fetch from the web (curl or wget to an http address) with nothing sent: a read, but one a workflow needs again. */
const FETCH = /(?:^|[\s;&|(])(?:curl|wget)\s[^|;&]*https?:\/\//;
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

function fileChanges(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const changes: unknown = JSON.parse(raw);
    if (Array.isArray(changes) && changes.length && changes.every((change) => isRecord(change) && typeof change.path === "string" && typeof change.diff === "string")) return { changes };
  } catch {}
  return undefined;
}

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

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

const isId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value);

/** The receipts a coordinate_bots answer lists (one per teammate), wherever the engine nested them. */
function receiptsIn(output: string | undefined): Array<Record<string, unknown>> {
  if (!output) return [];
  let budget = 400;
  const walk = (node: unknown): Array<Record<string, unknown>> => {
    if (--budget < 0) return [];
    if (typeof node === "string") {
      if (!node.includes("receipts")) return [];
      try { return walk(JSON.parse(node)); } catch { return []; }
    }
    if (Array.isArray(node)) return node.flatMap(walk);
    if (isRecord(node)) return Array.isArray(node.receipts) ? node.receipts.filter(isRecord) : Object.values(node).flatMap(walk);
    return [];
  };
  return walk(output);
}

/** One coordinate_bots call as the run made it, or null for an answer to a teammate's question (not new work). */
function delegateCall(input: Record<string, unknown> | undefined, output: string | undefined): DelegateCall | null {
  const ids = Array.isArray(input?.bot_ids) ? input.bot_ids : Array.isArray(input?.botIds) ? input.botIds : [];
  const message = text(input?.message);
  if (!ids.length || !message || text(input?.answers)) return null;
  const receipts = receiptsIn(output);
  const requests: DelegateCall["requests"] = [];
  const bots = ids.filter((id): id is string => typeof id === "string").map((given) => {
    const wanted = given.trim().toLowerCase();
    const receipt = receipts.find((one) => String(one.botId ?? "").toLowerCase() === wanted || String(one.botName ?? "").toLowerCase() === wanted.replace(/^@/, "") || (wanted.length >= 8 && String(one.botId ?? "").toLowerCase().startsWith(wanted)));
    const id = typeof receipt?.botId === "string" ? receipt.botId : isId(given) ? given : undefined;
    const name = typeof receipt?.botName === "string" ? receipt.botName : isId(given) ? given.slice(0, 8) : given.replace(/^@/, "");
    requests.push({ name, ...(id ? { botId: id } : {}), ...(typeof receipt?.requestId === "string" ? { requestId: receipt.requestId } : {}) });
    return { ...(id ? { id } : {}), name };
  });
  const doneWhen = text(input?.done_when) ?? text(input?.doneWhen);
  return { bots, message, ...(doneWhen ? { doneWhen } : {}), ...(input?.rework === true ? { rework: true } : {}), ...(input?.consult === true ? { consult: true } : {}), requests };
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
  // The app's own rows ("recovery: …", "Sent to Kiwi", "Kiwi replied", "Resumed with …") ride in activity messages too;
  // they are not steps.
  if (STATUS_ROW.test(tool.name) || isServerRow(message)) return [];
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
  if (COORDINATE.test(tool.name)) {
    const call = delegateCall(input, tool.output);
    if (!call) return [];
    return [{ ...base, id: message.id, kind: "delegate", tool: "coordinate_bots", words: call.bots.map((bot) => bot.name).join(", "), read: false, replay: clipped ? "ai" : "exact", delegation: { rounds: [[call]], replies: [] } }];
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
    const edit = FILE_EDIT.has(bare) ? input ?? (bare === "edit" ? fileChanges(tool.output) ?? fileChanges(tool.input) : undefined) : undefined;
    const path = text(input?.file_path) ?? text(input?.path) ?? text(input?.notebook_path);
    if (!path) return [{ ...base, id: message.id, kind: "ai", tool: bare, words: "edit files", read: false, replay: "ai", ...(edit ? { args: edit } : {}) }];
    const content = typeof input?.content === "string" ? input.content : undefined;
    const exact = FILE_WRITE.has(bare) && content !== undefined && !clipped;
    return [{ ...base, id: message.id, kind: exact ? "file" : "ai", tool: bare, words: baseName(path), read: false, replay: exact ? "exact" : "ai", args: exact ? { path, content } : edit ?? { path } }];
  }
  const command = text(tool.summary) ?? text(input?.command) ?? (nameIsCommand(tool.name) ? tool.name : undefined);
  if (command && (bare === "Bash" || bare === "shell" || bare === "vm_exec" || /^(?:exec_command|run_shell_command|bash|terminal)$/i.test(bare) || nameIsCommand(tool.name) || text(input?.command))) {
    const full = text(input?.command) ?? command;
    const parsed = parseRunCommand(full);
    const writes = redirectTarget(full);
    const fetches = FETCH.test(full);
    if (!parsed && !writes && !fetches) return [];
    const cwd = text(input?.cwd);
    const fetchOnly = !parsed && !writes;
    const words = fetchOnly ? hostOf(/https?:\/\/[^\s"'<>]+/.exec(full)?.[0] ?? "") || shellLine(full) : shellLine(full);
    return [{ ...base, id: message.id, kind: "shell", tool: bare === "vm_exec" ? "vm_exec" : "shell", words, read: fetchOnly, replay: clipped ? "ai" : "exact", args: { command: full, ...(cwd ? { cwd } : {}) } }];
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

/** The person's last ask, all of it. */
export function askTextOf(messages: readonly RunMessage[]): string | undefined {
  const index = askIndex(messages);
  return index < 0 ? undefined : messages[index]!.text!.trim() || undefined;
}

/** The person's last ask, its first line. */
export function askOf(messages: readonly RunMessage[]): string | undefined {
  const index = askIndex(messages);
  if (index < 0) return undefined;
  const line = messages[index]!.text!.trim().split(/\r?\n/, 1)[0]!.trim();
  return line || undefined;
}

/** A conversation's own folder in a command: shown as "." since the run happens in whatever conversation it is in. */
const CONVERSATION_FOLDER = /(?:[A-Za-z]:)?(?:[\\/][^\s"'`\\/;|&<>()]+)*[\\/]task-workspaces[\\/][0-9a-f-]{36}[\\/][0-9a-f-]{36}/g;
/** Moving about before the work (cd, pwd, mkdir -p of the folder, an echo): not what a command is for. */
const SETUP = /^(?:cd(?:\s|$)|pwd$|mkdir -p \.?$|echo\b(?![^>]*>)|set -\w+$|export \w+=|true$|:$|[A-Za-z_]\w*=\S*$)/;

/** A command as its layer reads: its first real segment (past cd, pwd and the like), cut at 60 characters. */
function shellLine(command: string): string {
  const clean = command.replace(CONVERSATION_FOLDER, ".").trim();
  const segments = clean.split(/\s*(?:&&|\|\||;|\r?\n)\s*/).map((one) => one.replace(/\s*2>\/dev\/null$/, "").replace(/^[({]\s*/, "").trim()).filter(Boolean);
  const line = (segments.find((one) => !SETUP.test(one)) ?? segments[0] ?? clean).replace(/\s+/g, " ");
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

/** The folders a command's leading `cd <dir> &&` steps move into, and the rest of it; null after any other `cd`. */
function afterCd(command: string): { folders: string[]; rest: string } | null {
  const folders: string[] = [];
  let rest = command;
  for (let found = LEADING_CD.exec(rest); found; found = LEADING_CD.exec(rest)) {
    folders.push(found[1] ?? found[2] ?? found[3]!);
    rest = rest.slice(found[0].length);
  }
  return /(?:^|[;&|(]\s*)cd(?:\s|$)/.test(rest) ? null : { folders, rest };
}
const LEADING_CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&\s*/;

/** A path as one key: the conversation folder as ".", either slash, and ".", ".." and repeated slashes resolved. */
function resolvePath(parts: readonly string[]): string {
  const out: string[] = [];
  let root = "";
  for (const part of parts) {
    const clean = part.replace(CONVERSATION_FOLDER, ".").replace(/\\/g, "/");
    const absolute = /^(?:[A-Za-z]:)?\//.exec(clean)?.[0];
    if (absolute) { root = absolute; out.length = 0; }
    for (const segment of clean.slice(absolute?.length ?? 0).split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === ".." && out.length && out[out.length - 1] !== "..") out.pop();
      else if (segment !== ".." || !root) out.push(segment);
    }
  }
  return root + out.join("/");
}

/** The file a layer writes, by its full path on its computer, and whether it only adds to the end of it. */
function writesTo(layer: BurgerLayer): { file: string; append: boolean } | null {
  const cwd = typeof layer.args?.cwd === "string" ? layer.args.cwd : ".";
  if (layer.kind === "file" && typeof layer.args?.path === "string") return { file: `${layer.where}:${resolvePath([cwd, layer.args.path])}`, append: false };
  if (layer.kind !== "shell" || typeof layer.args?.command !== "string") return null;
  const moved = afterCd(layer.args.command);
  const redirect = moved && redirectOf(moved.rest);
  return redirect ? { file: `${layer.where}:${resolvePath([cwd, ...moved.folders, redirect.path])}`, append: redirect.append } : null;
}

/** A read the run made that leaves no layer: a page looked at, a file or listing read. */
function looked(message: RunMessage): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool?.name || isServerRow(message) || tool.ok === false) return false;
  const { bare } = splitName(tool.name);
  return BROWSER_LOOK.test(bare) || /^(?:Read|WebFetch|read_file|view)$/.test(bare) || bare === "Bash" || bare === "shell";
}

/** The run since the person's last ask, as layers. */
export function burgerLayers(messages: readonly RunMessage[], live: ReadonlySet<string> = new Set()): BurgerLayer[] {
  const run = messages.slice(askIndex(messages) + 1);
  const layers: BurgerLayer[] = [];
  let read = false;
  let repliesSeen = 0;
  const round = new Map<string, number>();
  for (const message of run) {
    if (message.roomRequest?.phase === "result") repliesSeen += 1;
    const found = layersOf(message, live);
    for (const layer of found) {
      if (read) layer.afterRead = true;
      if (layer.kind === "delegate") round.set(layer.id, repliesSeen);
      layers.push(layer);
    }
    if (!found.length && looked(message)) read = true;
    if (found.some((layer) => layer.read)) read = true;
  }
  const kept: BurgerLayer[] = [];
  const writes = layers.map(writesTo);
  const rewrites = (earlier: number, later: number) => {
    const [first, last] = [writes[earlier], writes[later]];
    return Boolean(first && last && !first.append && !last.append && first.file === last.file
      && !writes.slice(earlier + 1, later).some((between) => between?.append && between.file === first.file));
  };
  const replaced = (earlier: number, later: number) => layers[later]!.status !== "failed"
    && ((sameStep(layers[earlier]!, layers[later]!) && layers[earlier]!.status === "failed") || rewrites(earlier, later));
  layers.forEach((layer, index) => {
    if (layers.some((_, later) => later > index && replaced(index, later))) return;
    const tries = layers.filter((_, earlier) => earlier < index && replaced(earlier, index)).length;
    kept.push(tries && layer.status !== "failed" ? { ...layer, tries } : layer);
  });
  return withReview(joinDelegations(joinDesktop(kept), round, repliesIn(run)), run);
}

/** Each teammate's reply in the run, by the hand-off it answers. */
function repliesIn(run: readonly RunMessage[]): Map<string, Omit<DelegateReply, "round">> {
  const out = new Map<string, Omit<DelegateReply, "round">>();
  for (const message of run) {
    const request = message.roomRequest;
    if (message.kind !== "activity" || request?.phase !== "result" || !request.id) continue;
    out.set(request.id, {
      name: message.from?.name ?? "", ...(message.from?.botId ? { botId: message.from.botId } : {}), requestId: request.id,
      ok: message.tool?.ok !== false, text: message.tool?.output ?? message.tool?.name ?? "",
    });
  }
  return out;
}

const botsOf = (layer: BurgerLayer) => new Set((layer.delegation?.rounds.flat() ?? []).flatMap((call) => call.bots.map((bot) => bot.id ?? bot.name)));

/** coordinate_bots calls made together (one after another, before any reply came back) are one step that asks several
 * teammates at once. A later call to teammates that step already asked is another round of it, not a new step. Each
 * reply joins the round that asked for it. */
function joinDelegations(layers: BurgerLayer[], round: Map<string, number>, replies: ReadonlyMap<string, Omit<DelegateReply, "round">>): BurgerLayer[] {
  const out: BurgerLayer[] = [];
  for (const layer of layers) {
    if (layer.kind !== "delegate" || !layer.delegation) { out.push(layer); continue; }
    const call = layer.delegation.rounds[0]![0]!;
    const last = out[out.length - 1];
    if (last?.kind === "delegate" && last.delegation && round.get(last.id) === round.get(layer.id)) {
      const rounds = last.delegation.rounds;
      rounds[rounds.length - 1]!.push(call);
      out[out.length - 1] = { ...last, words: [...new Set([...last.words.split(", "), ...layer.words.split(", ")])].join(", "), status: last.status === "failed" ? layer.status : last.status };
      round.set(out[out.length - 1]!.id, round.get(layer.id)!);
      continue;
    }
    const ids = call.bots.map((bot) => bot.id ?? bot.name);
    const earlier = [...out].reverse().find((one) => one.kind === "delegate" && ids.every((id) => botsOf(one).has(id)));
    if (earlier?.delegation && round.get(earlier.id) !== round.get(layer.id)) {
      const rounds = earlier.delegation.rounds;
      const lastRoundAt = round.get(`${earlier.id}#last`) ?? round.get(earlier.id);
      if (lastRoundAt === round.get(layer.id)) rounds[rounds.length - 1]!.push(call);
      else rounds.push([call]);
      round.set(`${earlier.id}#last`, round.get(layer.id)!);
      continue;
    }
    out.push(layer);
  }
  for (const layer of out) {
    if (!layer.delegation) continue;
    layer.delegation.replies = layer.delegation.rounds.flatMap((calls, index) => calls.flatMap((call) => call.requests.flatMap((request) => {
      const reply = request.requestId ? replies.get(request.requestId) : undefined;
      return reply ? [{ ...reply, name: reply.name || request.name, round: index + 1 }] : [];
    })));
    // A teammate still working: the step is still going, whatever the bot said meanwhile.
    const open = layer.delegation.rounds.flat().some((call) => call.requests.some((request) => request.requestId && !replies.has(request.requestId)));
    if (open && layer.status === "done") layer.status = "running";
  }
  return out;
}

/** A run that handed work out ends with the bot's own review of what came back: a layer the AI does again next time. */
function withReview(layers: BurgerLayer[], run: readonly RunMessage[]): BurgerLayer[] {
  if (!layers.some((layer) => layer.kind === "delegate") || layers.some((layer) => layer.kind === "delegate" && layer.status === "running")) return layers;
  let lastReply = -1;
  run.forEach((message, index) => { if (message.roomRequest?.phase === "result") lastReply = index; });
  if (lastReply < 0) return layers;
  const words = run.slice(lastReply + 1).filter((message) => message.role === "bot" && message.kind === "text" && !message.roomRequest && message.text?.trim());
  const verdict = words[words.length - 1];
  if (!verdict) return layers;
  return [...layers, {
    id: verdict.id, messageId: verdict.id, kind: "ai", tool: "review", words: "review what came back and report", status: "done", read: false,
    where: "bot", replay: "ai", review: true, afterRead: true, args: { text: verdict.text!.trim() },
  }];
}

/** A burger shows for a run of two real steps or more. */
export const BURGER_MIN_LAYERS = 2;

/** A run worth a burger: two steps or more, and not only fetches (looking things up changes nothing). */
export const burgerWorthy = (layers: readonly BurgerLayer[]) => layers.length >= BURGER_MIN_LAYERS && layers.some((layer) => !layer.read);
