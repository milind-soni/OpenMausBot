import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Document, type Node } from "yaml";
import { z } from "zod";

import { APPROVAL_MODES, type ApprovalMode } from "./approval-mode.ts";
import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "./bot-profile.ts";
import { MCP_SERVER_NAME, RESERVED_MCP_NAMES } from "./mcp-name.ts";
import { AGENT_MAX_SKILLS, isLoopbackHost, TEAM_BRIEF_MAX_BYTES, utf8Bytes } from "./package-format.ts";
import { findInvisibles, findLeaks, leakIn, type Leak } from "./profile-leaks.ts";
import { isSkillName, parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES } from "./skill-md.ts";
import { TOOL_GROUPS, type ToolGroup } from "./tool-groups.ts";
import { parseToolScope, type ToolScope } from "./tool-scope.ts";
import { CONNECTOR_SLUG_PATTERN, CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "./wire.ts";

export const PROFILE_VERSION = 1;
export const PROFILE_FILE_MAX_BYTES = 256 * 1024;
export const PROFILE_FOLDER_MAX_BYTES = 4 * 1024 * 1024;
export const PROFILE_FOLDER_MAX_FILES = 500;
export const PROFILE_FOLDER_MAX_ENTRIES = 2_000;
export const PROFILE_MAX_AREAS = 100;
export const PROFILE_MAX_BOTS = 200;
export const PROFILE_MAX_MCP_SERVERS = 50;
export const PROFILE_MAX_PROBLEMS = 200;

/** One thing wrong with a profile folder. `line` is the file's own line number, front matter included. */
export interface ProfileProblem {
  file: string;
  line?: number;
  field?: string;
  message: string;
}

/** A problem as one plain sentence: `areas/bi/bots/analyst.md, line 9: model must be INSTANCE/MODEL…`. */
export function problemSentence(problem: ProfileProblem): string {
  const where = problem.line ? `${problem.file}, line ${problem.line}` : problem.file;
  return `${where}: ${problem.field ? `${problem.field} ` : ""}${problem.message}`;
}

export type SecretRef = { secret: string } | { env: string } | { file: string };
export type ProfileApproval = Exclude<ApprovalMode, "custom">;
export type ProfileEduBrain = { mode: "own" } | { mode: "area" } | { mode: "off" } | { mode: "cloud"; url: string; token: SecretRef };

/** The bot settings an organization or an area may set for every bot under it, and a bot for itself. */
export interface InheritedFields {
  model?: string;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  approval?: ProfileApproval;
  tools?: ToolScope;
  toolsOff?: ToolGroup[];
  connectors?: Record<string, ConnectorToolGrant>;
  eduBrain?: ProfileEduBrain;
  eduCrew?: boolean;
  memory?: { enabled?: boolean; upkeep?: boolean };
}
export const INHERITED_FIELDS = ["model", "effort", "approval", "tools", "toolsOff", "connectors", "eduBrain", "eduCrew", "memory"] as const;
export type InheritedField = (typeof INHERITED_FIELDS)[number];
export type ProfileLevel = "org" | "area" | "bot";

export interface OrgProfile {
  file: string;
  name: string;
  brief: string;
  defaults: InheritedFields;
  mcpServers: string[];
  maxApproval?: ProfileApproval;
}

export interface AreaProfile {
  file: string;
  key: string;
  name: string;
  brief: string;
  chief?: string;
  stewards: string[];
  defaults: InheritedFields;
  mcpServers: string[];
  maxApproval?: ProfileApproval;
}

export interface BotProfile {
  file: string;
  area: string;
  key: string;
  name: string;
  was?: string;
  title?: string;
  description?: string;
  soul: string;
  fields: InheritedFields;
  mcpServers: string[];
  skills: Array<{ file: string; enabled: boolean }>;
}

export interface McpServerProfile {
  file: string;
  key: string;
  description?: string;
  notes: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string | SecretRef>;
  command?: string;
  args?: string[];
  env?: Record<string, string | SecretRef>;
}

export interface SkillProfile {
  file: string;
  area: string;
  name: string;
  description: string;
  text: string;
}

/** A bot with its organization's and area's defaults applied: what the app would make of it. */
export interface ResolvedBot extends InheritedFields {
  /** `<area key>/<bot key>`: the bot's identity across renames. */
  id: string;
  area: string;
  key: string;
  file: string;
  name: string;
  was?: string;
  title?: string;
  description?: string;
  soul: string;
  chief: boolean;
  mcpServers: string[];
  skills: Array<{ name: string; file: string; enabled: boolean }>;
  /** Which level each inherited field came from. A field no level sets is absent: the app's own default applies. */
  from: Partial<Record<InheritedField, ProfileLevel>>;
}

export interface ProfileFolder {
  org?: OrgProfile;
  areas: AreaProfile[];
  bots: ResolvedBot[];
  mcpServers: McpServerProfile[];
  skills: SkillProfile[];
  problems: ProfileProblem[];
  warnings: ProfileProblem[];
}

export type ProfileFileRole =
  | { role: "org" }
  | { role: "area"; area: string }
  | { role: "bot"; area: string; key: string }
  | { role: "skill"; area: string; name: string }
  | { role: "mcp-server"; key: string };

const AREA_FILE = /^areas\/([^/]+)\/area\.md$/;
const BOT_FILE = /^areas\/([^/]+)\/bots\/([^/]+)\.md$/;
const SKILL_FILE = /^areas\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/;
const MCP_FILE = /^mcp\/([^/]+)\.md$/;

/** What a path inside the folder holds, by where it is; null for a file the folder's layout has no place for. */
export function profileFileRole(path: string): ProfileFileRole | null {
  if (path === "org.md") return { role: "org" };
  let match = AREA_FILE.exec(path);
  if (match) return { role: "area", area: match[1]! };
  match = BOT_FILE.exec(path);
  if (match) return { role: "bot", area: match[1]!, key: match[2]! };
  match = SKILL_FILE.exec(path);
  if (match) return { role: "skill", area: match[1]!, name: match[2]! };
  match = MCP_FILE.exec(path);
  if (match) return { role: "mcp-server", key: match[1]! };
  return null;
}

const KIND_OF_ROLE = { org: "organization", area: "area", bot: "bot", "mcp-server": "mcp-server" } as const;
/** An area or bot key. */
export const PROFILE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_RULE = "must be 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit";
const MODEL = /^[\w.-]+\/\S.*$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CREDENTIAL_NAME = /authorization|cookie|token|secret|passw|api[-_]?key|access[-_]?key|private[-_]?key|credential|^key$|[-_]key$/i;
const PATH_START = String.raw`(?:^|[\s=,;:"'(\[{])`;
const ABSOLUTE_PATH = new RegExp(String.raw`${PATH_START}(?:\/|~[\w.-]*(?:[/\\]|$|(?=[\s,;:"')\]}]))|[A-Za-z]:[\\/]|\\\\)`);
const CLIMBING_PATH = new RegExp(String.raw`(?:^|[\s=,;:"'(\[{/\\])\.\.(?:[/\\]|$|(?=[\s,;:"')\]}]))`);
const UNEXPANDED = /[$%~]/;
const BARE_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const SERVER_RUN_FIELDS = new Set(["command", "args", "env", "headers"]);
const FILE_ADDRESS = /(?<![a-z0-9+.-])file:/i;
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]*/gi;
const SECRET_ARG_FLAG = /^--?[A-Za-z0-9_-]*?(?:token|passw(?:or)?d|secret|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)s?(?:=(.*))?$/is;
const CI_KEY_FILE = /^\.secrets\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const EVERY_TOOL = "*";
const PROSE_FIELDS = new Set(["name", "was", "title", "description"]);
const PROFILE_APPROVALS = APPROVAL_MODES.filter((mode): mode is ProfileApproval => mode !== "custom");

const PER_PERSON: Record<string, string> = {
  cwd: "is chosen by each person in the app (a working folder is a path on one computer), so it never goes in a profile",
  computer: "is chosen by each person in the app (where a bot works depends on the computer), so it never goes in a profile",
  browserProfile: "is chosen by each person in the app, so it never goes in a profile",
  visibility: "is chosen by each person in the app, so it never goes in a profile",
};
const BODY_FIELDS: Record<string, string> = {
  soul: "goes in the Markdown below the front matter, not in a field",
  brief: "goes in the Markdown below the front matter, not in a field",
  notes: "goes in the Markdown below the front matter, not in a field",
};
const FOLDER_BRAIN = "mode folder names a folder on one computer, so profiles do not use it; use mode area (the bots of an area share a brain) or mode cloud";
const SECRET_HINT = "put it in a secret slot instead: { secret: NAME }";

const text = (max: number, what = "text") => z.string({ error: `must be ${what}` }).max(max, `must be at most ${max} characters`);
const oneLine = (max: number) => text(max).refine(fitsOnOneLine, "must fit on one line");
const requiredLine = (max: number) => oneLine(max).refine((value) => value.trim().length > 0, "must not be empty");
const keySchema = z.string({ error: "must be text" }).regex(PROFILE_KEY, KEY_RULE);
const approvalSchema = z.string({ error: "must be text" }).superRefine((value, context) => {
  if (value === "custom") context.addIssue({ code: "custom", message: "custom is set in the desktop app; a profile may say ask, edits, auto or full" });
  else if (!(PROFILE_APPROVALS as readonly string[]).includes(value)) context.addIssue({ code: "custom", message: "must be ask, edits, auto or full" });
}).transform((value) => value as ProfileApproval);

function urlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be a full https:// address";
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return "must be an https:// address (http:// only for this computer)";
  if (url.username || url.password) return `must not hold a user name or password; ${SECRET_HINT}`;
  return null;
}
const urlSchema = z.string({ error: "must be an address" }).max(2_000, "must be at most 2000 characters").superRefine((value, context) => {
  const problem = urlProblem(value);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

const secretRefSchema = z.union([
  z.object({ secret: z.string().regex(SECRET_NAME) }).strict(),
  z.object({ env: z.string().regex(ENV_NAME) }).strict(),
  z.object({ file: z.string().min(1).max(1_000) }).strict(),
], { error: "must be a secret slot: { secret: NAME } (or { env: NAME } or { file: PATH } for CI)" });

const valueOrSecret = z.union([z.string().max(2_000), secretRefSchema], { error: "must be text or a secret slot: { secret: NAME }" });

const eduBrainSchema = z.object({
  mode: z.string({ error: "must be own, area, cloud or off" }),
  url: z.unknown().optional(),
  token: z.unknown().optional(),
  path: z.unknown().optional(),
}, { error: "must be { mode: own }, { mode: area }, { mode: cloud, url, token } or { mode: off }" }).strict().superRefine((brain, context) => {
  if (brain.mode === "folder") return context.addIssue({ code: "custom", message: FOLDER_BRAIN });
  if (!["own", "area", "cloud", "off"].includes(brain.mode)) return context.addIssue({ code: "custom", path: ["mode"], message: "must be own, area, cloud or off" });
  if (brain.path !== undefined) context.addIssue({ code: "custom", path: ["path"], message: "is only for folder brains, which profiles do not use" });
  if (brain.mode !== "cloud") {
    for (const field of ["url", "token"] as const) {
      if (brain[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "is only for mode cloud" });
    }
    return;
  }
  if (brain.url === undefined) context.addIssue({ code: "custom", path: ["url"], message: "is required for mode cloud: the brain's https://…/mcp address" });
  else if (typeof brain.url !== "string") context.addIssue({ code: "custom", path: ["url"], message: "must be an address" });
  else {
    const problem = urlProblem(brain.url) ?? (/[?#]/.test(brain.url) ? "must be a plain address, without ? or #" : null);
    if (problem) context.addIssue({ code: "custom", path: ["url"], message: problem });
  }
  if (brain.token === undefined) context.addIssue({ code: "custom", path: ["token"], message: "is required for mode cloud: each person's token, as { secret: NAME }" });
  else if (!secretRefSchema.safeParse(brain.token).success) context.addIssue({ code: "custom", path: ["token"], message: `must be a secret slot; ${SECRET_HINT}` });
}).transform((brain): ProfileEduBrain => brain.mode === "cloud"
  ? { mode: "cloud", url: brain.url as string, token: brain.token as SecretRef }
  : { mode: brain.mode as "own" | "area" | "off" });

const selectorList = (everyTool: boolean) => z.array(z.string({ error: "must be a tool selector" }), { error: "must be a list of tool selectors" }).max(256, "must list at most 256 selectors")
  .superRefine((list, context) => {
    list.forEach((selector, index) => {
      if (everyTool && selector === EVERY_TOOL) {
        if (list.length > 1) context.addIssue({ code: "custom", path: [index], message: "is every tool, so it stands alone in allow: [\"*\"]" });
      } else if (!parseToolScope({ allow: [selector] }).ok) {
        context.addIssue({ code: "custom", path: [index], message: `is not a tool selector: use native:NAME, native:*, mcp:SERVER:NAME or mcp:SERVER:* (docs/tool-selection.md)` });
      }
    });
  });

const connectorsSchema = z.record(z.string(), z.object({
  tools: z.union([z.literal("*"), z.array(z.string().regex(CONNECTOR_TOOL_NAME_PATTERN, "must be a tool name such as GMAIL_FETCH_EMAILS")).min(1).max(500)],
    { error: "must be \"*\" or a list of tool names such as GMAIL_FETCH_EMAILS" }),
}, { error: "must be { tools: \"*\" } or { tools: [NAME, …] }" }).strict(), { error: "must map each app to its tools, such as gmail: { tools: [GMAIL_FETCH_EMAILS] }" })
  .superRefine((connectors, context) => {
    const slugs = Object.keys(connectors);
    if (slugs.length > 100) context.addIssue({ code: "custom", message: "must name at most 100 apps" });
    for (const slug of slugs) {
      if (!CONNECTOR_SLUG_PATTERN.test(slug)) context.addIssue({ code: "custom", path: [slug], message: "is not an app name: use the app's lowercase name, such as gmail" });
    }
  });

const inheritedShape = {
  model: z.string({ error: "must be INSTANCE/MODEL, such as claude/claude-sonnet-5-5" }).max(300).regex(MODEL, "must be INSTANCE/MODEL, such as claude/claude-sonnet-5-5").optional(),
  effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"], { error: "must be none, low, medium, high, xhigh or max" }).optional(),
  approval: approvalSchema.optional(),
  tools: z.object({ allow: selectorList(true).optional(), deny: selectorList(false).optional() }, { error: "must be { allow: [SELECTOR], deny: [SELECTOR] }" }).strict().optional(),
  toolsOff: z.array(z.enum(TOOL_GROUPS, { error: `must be one of ${TOOL_GROUPS.join(", ")}` }), { error: "must be a list of tool groups" }).max(20).optional(),
  connectors: connectorsSchema.optional(),
  eduBrain: eduBrainSchema.optional(),
  eduCrew: z.boolean({ error: "must be true or false" }).optional(),
  memory: z.object({ enabled: z.boolean({ error: "must be true or false" }).optional(), upkeep: z.boolean({ error: "must be true or false" }).optional() },
    { error: "must be { enabled: true|false, upkeep: true|false }" }).strict().optional(),
};

const mcpServerNames = z.array(z.string({ error: "must be a server name" }), { error: "must be a list of MCP server names" }).max(PROFILE_MAX_MCP_SERVERS)
  .superRefine((names, context) => {
    names.forEach((name, index) => {
      if (name === "edu") context.addIssue({ code: "custom", path: [index], message: "is Edu Bot's own memory server; set eduBrain instead" });
      else if (RESERVED_MCP_NAMES.has(name)) context.addIssue({ code: "custom", path: [index], message: "is a name Edu Bot keeps for its own tools" });
      else if (!MCP_SERVER_NAME.test(name)) context.addIssue({ code: "custom", path: [index], message: "must be 1 to 32 lowercase letters, digits, _ or -, starting with a letter" });
    });
  });

const header = { edubot: z.unknown(), kind: z.unknown() };
const defaultsSchema = z.object(inheritedShape, { error: "must list bot settings, such as model: and approval:" }).strict();

const orgSchema = z.object({
  ...header,
  name: requiredLine(100),
  defaults: defaultsSchema.optional(),
  mcpServers: mcpServerNames.optional(),
  maxApproval: approvalSchema.optional(),
}).strict();

const areaSchema = z.object({
  ...header,
  key: keySchema,
  name: requiredLine(60),
  chief: keySchema.optional(),
  stewards: z.array(z.string({ error: "must be an email address" }).regex(EMAIL, "must be an email address"), { error: "must be a list of email addresses" }).max(50).optional(),
  eduBrain: eduBrainSchema.optional(),
  defaults: defaultsSchema.optional(),
  mcpServers: mcpServerNames.optional(),
  maxApproval: approvalSchema.optional(),
}).strict();

const botSchema = z.object({
  ...header,
  key: keySchema,
  name: requiredLine(BOT_PROFILE_LIMITS.name),
  was: requiredLine(BOT_PROFILE_LIMITS.name).optional(),
  title: oneLine(BOT_PROFILE_LIMITS.title).optional(),
  description: text(BOT_PROFILE_LIMITS.description).optional(),
  ...inheritedShape,
  mcpServers: mcpServerNames.optional(),
  skills: z.array(z.object({ file: z.string({ error: "must be a path to a SKILL.md" }).min(1).max(1_000), enabled: z.boolean({ error: "must be true or false" }).optional() },
    { error: "must be { file: PATH, enabled: true|false }" }).strict(), { error: "must be a list of { file: PATH }" }).max(AGENT_MAX_SKILLS).optional(),
}).strict();

const mcpServerSchema = z.object({
  ...header,
  key: z.string({ error: "must be text" }),
  description: oneLine(300).optional(),
  transport: z.enum(["http", "sse", "stdio"], { error: "must be http, sse or stdio" }),
  url: urlSchema.optional(),
  headers: z.record(z.string(), valueOrSecret, { error: "must map each header name to its value" }).optional(),
  command: z.string({ error: "must be a command" }).min(1).max(1_000).optional(),
  args: z.array(z.string({ error: "must be text" }).max(4_000), { error: "must be a list of arguments" }).max(64).optional(),
  env: z.record(z.string(), valueOrSecret, { error: "must map each variable name to its value" }).optional(),
}).strict().superRefine((server, context) => {
  if (server.key === "edu") context.addIssue({ code: "custom", path: ["key"], message: "is Edu Bot's own memory server; set eduBrain on a bot or area instead" });
  else if (RESERVED_MCP_NAMES.has(server.key)) context.addIssue({ code: "custom", path: ["key"], message: "is a name Edu Bot keeps for its own tools" });
  else if (!MCP_SERVER_NAME.test(server.key)) context.addIssue({ code: "custom", path: ["key"], message: "must be 1 to 32 lowercase letters, digits, _ or -, starting with a letter" });
  const remote = server.transport !== "stdio";
  if (remote && server.url === undefined) context.addIssue({ code: "custom", path: ["url"], message: `is required for transport ${server.transport}` });
  for (const field of remote ? ["command", "args", "env"] as const : ["url", "headers"] as const) {
    if (server[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: `is not used with transport ${server.transport}` });
  }
  if (!remote && server.command === undefined) context.addIssue({ code: "custom", path: ["command"], message: "is required for transport stdio" });
  const named = (field: "headers" | "env", pattern: RegExp, what: string) => {
    const entries = Object.entries(server[field] ?? {});
    if (entries.length > 32) context.addIssue({ code: "custom", path: [field], message: "must have at most 32 entries" });
    for (const [name, value] of entries) {
      if (!pattern.test(name)) context.addIssue({ code: "custom", path: [field, name], message: `is not a valid ${what} name` });
      else if (typeof value === "string" && CREDENTIAL_NAME.test(name)) context.addIssue({ code: "custom", path: [field, name], message: `holds a credential; ${SECRET_HINT}` });
    }
  };
  named("headers", HEADER_NAME, "header");
  named("env", ENV_NAME, "variable");
});

type Kind = keyof typeof KIND_OF_ROLE;

interface ParsedDoc {
  file: string;
  data: Record<string, unknown>;
  body: string;
  lineOf(path: readonly (string | number)[], key?: boolean): number | undefined;
}

class Problems {
  readonly list: ProfileProblem[] = [];
  readonly warnings: ProfileProblem[] = [];
  private readonly reportedFields = new Set<string>();
  private readonly reportedLines = new Set<string>();

  add(problem: ProfileProblem): void {
    this.reportedFields.add(`${problem.file}\0${problem.field ?? ""}`);
    if (problem.line) this.reportedLines.add(`${problem.file}\0${problem.line}`);
    if (this.list.length < PROFILE_MAX_PROBLEMS) this.list.push(problem);
  }

  warn(problem: ProfileProblem): void {
    if (this.warnings.length < PROFILE_MAX_PROBLEMS) this.warnings.push(problem);
  }

  hasLine(file: string, line: number): boolean {
    return this.reportedLines.has(`${file}\0${line}`);
  }

  has(file: string, field: string): boolean {
    for (const prefix of fieldPrefixes(field)) if (this.reportedFields.has(`${file}\0${prefix}`)) return true;
    return false;
  }

  fileHas(file: string): boolean {
    return this.list.some((problem) => problem.file === file);
  }
}

function fieldPrefixes(field: string): string[] {
  const prefixes: string[] = [];
  const parts = field.split(/(?=[.[])/);
  for (let i = 1; i <= parts.length; i++) prefixes.push(parts.slice(0, i).join(""));
  return prefixes;
}

/** A field's path as a problem names it: `tools.allow[2]`, `headers.Authorization`. */
export function fieldName(path: readonly PropertyKey[]): string {
  return path.map((part, index) => typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${String(part)}`).join("");
}

function nodeAt(doc: Document, path: readonly (string | number)[], key: boolean): Node | undefined {
  let node: unknown = doc.contents;
  let found: Node | undefined = node as Node | undefined;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isMap(node)) {
      const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && item.key.value === part);
      if (!pair) return found;
      if (key && i === path.length - 1) return pair.key as Node;
      found = (pair.key as Node) ?? found;
      node = pair.value;
    } else if (isSeq(node) && typeof part === "number") {
      node = node.items[part];
    } else return found;
    if (node && typeof node === "object" && "range" in node) found = node as Node;
  }
  return found;
}

function frontMatterEnd(source: string): number | "missing" | "unclosed" {
  if (!source.startsWith("---\n")) return "missing";
  let end = source.indexOf("\n---", 3);
  while (end >= 0 && end + 4 < source.length && source[end + 4] !== "\n") end = source.indexOf("\n---", end + 1);
  return end < 0 ? "unclosed" : end;
}

function bodyLineOf(source: string): number {
  const end = frontMatterEnd(source);
  if (end === "missing") return 1;
  if (end === "unclosed") return Number.MAX_SAFE_INTEGER;
  return source.slice(4, end + 1).split("\n").length + 2;
}

function splitFrontMatter(file: string, source: string, problems: Problems): { yaml: string; body: string; bodyLine: number } | null {
  const end = frontMatterEnd(source);
  if (end === "missing") {
    problems.add({ file, line: 1, message: "must start with a front matter block: a line with ---, the YAML fields, then another ---" });
    return null;
  }
  if (end === "unclosed") {
    problems.add({ file, line: 1, message: "has a front matter block that never closes: end it with a line holding only ---" });
    return null;
  }
  return { yaml: source.slice(4, end + 1), body: source.slice(Math.min(end + 5, source.length)), bodyLine: bodyLineOf(source) };
}

function invisibleProblem(file: string, line: number | undefined, codePoint: number): ProfileProblem {
  const name = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return { file, ...(line ? { line } : {}), message: `has an invisible or control character (${name}) on this line; delete it, since profile settings never need one` };
}

/** YAML escapes such as `"\u200B"` are plain ASCII in the file, so each decoded field name and text value is checked
 * again. */
function refuseDecodedInvisibles(file: string, data: unknown, lineOf: ParsedDoc["lineOf"], problems: Problems): boolean {
  let found = false;
  const check = (text: string, path: (string | number)[], key: boolean) => {
    const invisible = findInvisibles(text, Number.MAX_SAFE_INTEGER)[0];
    if (!invisible) return;
    found = true;
    const line = lineOf(path, key) ?? 2;
    if (!problems.hasLine(file, line)) problems.add(invisibleProblem(file, line, invisible.codePoint));
  };
  const walk = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") return check(value, path, false);
    if (Array.isArray(value)) return value.forEach((entry, index) => walk(entry, [...path, index]));
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      check(key, [...path, key], true);
      walk(entry, [...path, key]);
    }
  };
  walk(data, []);
  return found;
}

function parseFrontMatter(file: string, source: string, problems: Problems): (ParsedDoc & { bodyLine: number }) | null {
  const split = splitFrontMatter(file, source, problems);
  if (!split) return null;
  const counter = new LineCounter();
  const doc = parseDocument(split.yaml, { lineCounter: counter, prettyErrors: true, uniqueKeys: true });
  const lastLine = split.yaml.split("\n").length;
  const lineOfOffset = (offset: number) => Math.min(counter.linePos(offset).line + 1, lastLine);
  const yamlProblems = [...doc.errors, ...doc.warnings];
  if (yamlProblems.length) {
    for (const error of yamlProblems) {
      const line = error.linePos?.[0]?.line === undefined ? undefined : Math.min(error.linePos[0].line, lastLine - 1);
      const message = error.code === "DUPLICATE_KEY" ? "has the same field twice" : `is not valid YAML: ${error.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}`;
      problems.add({ file, ...(line ? { line: line + 1 } : {}), message });
    }
    return null;
  }
  let alias: number | undefined;
  visit(doc, { Alias(_key, node) { alias ??= node.range ? lineOfOffset(node.range[0]) : undefined; } });
  if (alias !== undefined || doc.contents && isAlias(doc.contents)) {
    problems.add({ file, ...(alias ? { line: alias } : {}), message: "uses a YAML alias (*name); write the value out in full" });
    return null;
  }
  const data = doc.toJS({ maxAliasCount: 0 }) as unknown;
  const lineOf: ParsedDoc["lineOf"] = (path, key = false) => {
    const node = nodeAt(doc, path, key);
    return node?.range ? lineOfOffset(node.range[0]) : undefined;
  };
  if (refuseDecodedInvisibles(file, data, lineOf, problems)) return null;
  if (data === null || data === undefined) {
    problems.add({ file, line: 2, message: "has an empty front matter: it needs at least edubot: 1 and kind:" });
    return null;
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    problems.add({ file, line: 2, message: "has a front matter that is not a list of fields (field: value, one per line)" });
    return null;
  }
  return {
    file,
    data: data as Record<string, unknown>,
    body: split.body,
    bodyLine: split.bodyLine,
    lineOf,
  };
}

function checkHeader(doc: ParsedDoc, kind: Kind, problems: Problems): boolean {
  const { file, data } = doc;
  const expected = KIND_OF_ROLE[kind];
  if (data.edubot === undefined) {
    problems.add({ file, line: 2, field: "edubot", message: "is required: start the front matter with edubot: 1" });
    return false;
  }
  if (typeof data.edubot === "number" && data.edubot > PROFILE_VERSION) {
    problems.add({ file, line: doc.lineOf(["edubot"]), field: "edubot", message: `is ${data.edubot}: this folder was written for a newer Edu Bot, so update the app` });
    return false;
  }
  if (data.edubot !== PROFILE_VERSION) {
    problems.add({ file, line: doc.lineOf(["edubot"]), field: "edubot", message: "must be 1" });
    return false;
  }
  if (data.kind === undefined) {
    problems.add({ file, line: 2, field: "kind", message: `is required: this file holds kind: ${expected}` });
    return false;
  }
  if (data.kind !== expected) {
    problems.add({ file, line: doc.lineOf(["kind"]), field: "kind", message: `does not match this place in the folder, which holds kind: ${expected}` });
    return false;
  }
  return true;
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let value = data;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[part];
  }
  return value;
}

function schemaProblems(doc: ParsedDoc, error: z.ZodError, what: string, problems: Problems): void {
  for (const issue of error.issues) {
    const path = issue.path.filter((part): part is string | number => typeof part !== "symbol");
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const field = fieldName([...path, key]);
        const reason = (Object.hasOwn(PER_PERSON, key) ? PER_PERSON[key] : Object.hasOwn(BODY_FIELDS, key) ? BODY_FIELDS[key] : undefined)
          ?? `is not a field ${what} can have (docs/profiles.md lists them)`;
        problems.add({ file: doc.file, line: doc.lineOf([...path, key], true), field, message: reason });
      }
      continue;
    }
    const field = fieldName(path);
    if (problems.has(doc.file, field)) continue;
    const missing = issue.code === "invalid_type" && valueAt(doc.data, path) === undefined;
    problems.add({ file: doc.file, line: doc.lineOf(path) ?? 2, field, message: missing ? "is required" : issue.message });
  }
}

const isKeyFileSlot = (value: unknown): value is { file: string } =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 1 && typeof (value as { file?: unknown }).file === "string";

function pathProblem(value: string, path: (string | number)[], role: ProfileFileRole["role"]): string | null {
  const runs = role === "mcp-server" && SERVER_RUN_FIELDS.has(String(path[0]));
  if (runs && UNEXPANDED.test(value)) {
    return "holds a $, % or ~; Edu Bot passes a server's command, arguments, variables and headers as written and never runs a shell, so nothing would expand them";
  }
  if (path.at(-1) === "url" && BARE_PERCENT.test(value)) return "holds a % that does not start a %XX escape such as %20; an address uses % only for those";
  const plain = value.replace(ADDRESS, (address) => /^file:/i.test(address) ? address : " ");
  if (ABSOLUTE_PATH.test(plain) || FILE_ADDRESS.test(plain)) return "holds an absolute or home path; paths differ on each computer, so profiles never hold one";
  if (runs && path[0] !== "headers" && CLIMBING_PATH.test(plain)) {
    return "holds a path that climbs with ..; paths differ on each computer, so a server's command, arguments and variables never use one";
  }
  return null;
}

/** Whether a value holds a key, a path, or a character the server would get unexpanded; the file is then not kept. */
function refusePathsAndKeys(doc: ParsedDoc, role: ProfileFileRole["role"], problems: Problems): boolean {
  let refused = refuseSecretArguments(doc, role, problems);
  const walk = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") {
      const field = fieldName(path);
      const leak = leakIn(value);
      if (leak) {
        refused = true;
        const message = leak === "address" ? `holds an address with a user name or password; take them out of the address and ${SECRET_HINT}` : `holds a key or password; ${SECRET_HINT}`;
        if (!problems.has(doc.file, field)) problems.add({ file: doc.file, line: doc.lineOf(path), field, message });
        return;
      }
      if (problems.has(doc.file, field) || PROSE_FIELDS.has(String(path[0]))) return;
      const message = pathProblem(value, path, role);
      if (message) {
        refused = true;
        problems.add({ file: doc.file, line: doc.lineOf(path), field, message });
      }
      return;
    }
    if (path[0] !== "skills" && isKeyFileSlot(value)) return;
    if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, [...path, index]));
    else if (value && typeof value === "object") for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], [...path, key]);
  };
  walk(doc.data, []);
  return refused;
}

function refuseSecretArguments(doc: ParsedDoc, role: ProfileFileRole["role"], problems: Problems): boolean {
  const args = doc.data.args;
  if (role !== "mcp-server" || !Array.isArray(args)) return false;
  let leaked = false;
  const refuse = (index: number, message: string) => {
    leaked = true;
    const field = `args[${index}]`;
    if (!problems.has(doc.file, field)) problems.add({ file: doc.file, line: doc.lineOf(["args", index]), field, message });
  };
  const hint = "pass the key in env with a secret slot instead, such as env: { NOTION_TOKEN: { secret: NAME } }";
  args.forEach((arg, index) => {
    const flag = typeof arg === "string" ? SECRET_ARG_FLAG.exec(arg) : null;
    if (!flag) return;
    const next = args[index + 1];
    if (flag[1] !== undefined) {
      if (flag[1] !== "") refuse(index, `gives a flag that names a key or password its value; ${hint}`);
    } else if (typeof next === "string" && next !== "" && !next.startsWith("-")) {
      refuse(index + 1, `is the value of ${arg}, a flag that names a key or password; ${hint}`);
    }
  });
  return leaked;
}

function bodyText(doc: ParsedDoc & { bodyLine: number }, what: string, maxBytes: number, problems: Problems): string {
  const body = doc.body.trim() ? doc.body.replace(/^\n+/, "").trimEnd() : "";
  if (utf8Bytes(body) > maxBytes) problems.add({ file: doc.file, line: doc.bodyLine, message: `has ${what} over ${maxBytes.toLocaleString("en-US")} bytes` });
  return body;
}

function reportLeaks(file: string, leaks: readonly Leak[], body: { line: number; name: string }, problems: Problems): void {
  for (const leak of leaks) {
    if (problems.hasLine(file, leak.line)) continue;
    const where = leak.line >= body.line ? `in ${body.name}` : "on this line";
    const message = leak.kind === "address"
      ? `has an address with a user name or password ${where}; take them out of the address and ${SECRET_HINT}`
      : `has a key or password ${where}; take it out and ${SECRET_HINT}`;
    problems.add({ file, line: leak.line, message });
  }
}

/** A relative path from the folder's root, with `..` resolved; null when it climbs out of the root. */
export function joinInside(dir: string, relative: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const part of relative.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

const dirOf = (file: string) => file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

function checkKeyFiles(doc: ParsedDoc, problems: Problems): void {
  const walk = (value: unknown, path: (string | number)[]) => {
    if (Array.isArray(value)) return value.forEach((entry, index) => walk(entry, [...path, index]));
    if (!value || typeof value !== "object") return;
    if (isKeyFileSlot(value)) {
      const field = fieldName([...path, "file"]);
      if (!problems.has(doc.file, field) && !CI_KEY_FILE.test(value.file)) {
        problems.add({ file: doc.file, line: doc.lineOf([...path, "file"]), field,
          message: "must name a file in the folder's .secrets/ folder, such as .secrets/notion: a key file is for CI, which writes it there before it applies the profiles and never commits it" });
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) walk(record[key], [...path, key]);
  };
  for (const key of Object.keys(doc.data)) if (key !== "skills") walk(doc.data[key], [key]);
}

function inherited(data: Record<string, unknown>): InheritedFields {
  const fields: Record<string, unknown> = {};
  for (const field of INHERITED_FIELDS) if (data[field] !== undefined) fields[field] = data[field];
  return fields as InheritedFields;
}

interface Parsed {
  org?: OrgProfile;
  areas: Map<string, AreaProfile>;
  bots: BotProfile[];
  mcpServers: Map<string, McpServerProfile>;
  skills: Map<string, SkillProfile>;
  docs: Map<string, ParsedDoc>;
}

const BODY_NAME = { org: "the organization's brief", area: "the area's brief", bot: "the bot's instructions", "mcp-server": "the notes" } as const;

/** A file that holds a key, or an invisible character in its settings, is reported and never kept, so no output
 * repeats what it holds. An MCP server's notes count as settings; a Markdown brief or instructions do not. */
function parseOne(file: string, source: string, role: ProfileFileRole, parsed: Parsed, problems: Problems): void {
  if (role.role === "skill") return parseSkill(file, source, role, parsed, problems);
  const bodyLine = bodyLineOf(source);
  const invisibles = findInvisibles(source, role.role === "mcp-server" ? Number.MAX_SAFE_INTEGER : bodyLine - 1);
  for (const { line, codePoint } of invisibles) problems.add(invisibleProblem(file, line, codePoint));
  const leaks = findLeaks(source, bodyLine - 1);
  if (!invisibles.length) parseProfile(file, source, role, leaks.length > 0, parsed, problems);
  reportLeaks(file, leaks, { line: bodyLine, name: BODY_NAME[role.role] }, problems);
}

function parseProfile(file: string, source: string, role: Exclude<ProfileFileRole, { role: "skill" }>, leaked: boolean, parsed: Parsed, problems: Problems): void {
  const doc = parseFrontMatter(file, source, problems);
  if (!doc || !checkHeader(doc, role.role, problems)) return;
  parsed.docs.set(file, doc);
  const what = { org: "an organization", area: "an area", bot: "a bot", "mcp-server": "an MCP server" }[role.role];
  const schema = { org: orgSchema, area: areaSchema, bot: botSchema, "mcp-server": mcpServerSchema }[role.role];
  const result = schema.safeParse(doc.data);
  if (!result.success) schemaProblems(doc, result.error, what, problems);
  const refusedValue = refusePathsAndKeys(doc, role.role, problems);
  checkKeyFiles(doc, problems);
  const keyMatches = (key: unknown, expected: string, where: string) => {
    if (typeof key !== "string" || problems.has(file, "key") || key === expected) return;
    problems.add({ file, line: doc.lineOf(["key"]), field: "key", message: `does not match the name of the ${where}, ${expected}; rename one so they match` });
  };
  if (role.role === "area") keyMatches(doc.data.key, role.area, "area's folder");
  if (role.role === "bot") keyMatches(doc.data.key, role.key, "file");
  if (role.role === "mcp-server") keyMatches(doc.data.key, role.key, "file");
  if (role.role === "area" && doc.data.eduBrain !== undefined && valueAt(doc.data, ["defaults", "eduBrain"]) !== undefined) {
    problems.add({ file, line: doc.lineOf(["defaults", "eduBrain"], true), field: "defaults.eduBrain", message: "repeats eduBrain; set it once, either at the top or under defaults" });
  }
  const body = bodyText(doc, BODY_NAME[role.role], role.role === "bot" ? BOT_PROFILE_LIMITS.soul : TEAM_BRIEF_MAX_BYTES, problems);
  if (!result.success || leaked || refusedValue) return;
  const data = result.data as Record<string, unknown>;
  if (role.role === "org") {
    const org = data as z.output<typeof orgSchema>;
    parsed.org = { file, name: org.name.trim(), brief: body, defaults: inherited(org.defaults ?? {}), mcpServers: org.mcpServers ?? [], ...(org.maxApproval ? { maxApproval: org.maxApproval } : {}) };
  } else if (role.role === "area") {
    const area = data as z.output<typeof areaSchema>;
    const defaults = inherited(area.defaults ?? {});
    if (area.eduBrain) defaults.eduBrain = area.eduBrain;
    parsed.areas.set(role.area, {
      file, key: area.key, name: area.name.trim(), brief: body, ...(area.chief ? { chief: area.chief } : {}),
      stewards: [...new Set((area.stewards ?? []).map((email) => email.toLowerCase()))], defaults, mcpServers: area.mcpServers ?? [],
      ...(area.maxApproval ? { maxApproval: area.maxApproval } : {}),
    });
  } else if (role.role === "bot") {
    const bot = data as z.output<typeof botSchema>;
    parsed.bots.push({
      file, area: role.area, key: bot.key, name: bot.name.trim(), ...(bot.was ? { was: bot.was.trim() } : {}), ...(bot.title !== undefined ? { title: bot.title } : {}),
      ...(bot.description !== undefined ? { description: bot.description } : {}), soul: body, fields: inherited(bot), mcpServers: bot.mcpServers ?? [],
      skills: (bot.skills ?? []).map((skill) => ({ file: skill.file, enabled: skill.enabled !== false })),
    });
  } else {
    const server = data as z.output<typeof mcpServerSchema>;
    parsed.mcpServers.set(server.key, {
      file, key: server.key, notes: body, transport: server.transport, ...(server.description ? { description: server.description } : {}),
      ...(server.url ? { url: server.url } : {}), ...(server.headers ? { headers: server.headers } : {}), ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}),
    });
  }
}

function parseSkill(file: string, source: string, role: Extract<ProfileFileRole, { role: "skill" }>, parsed: Parsed, problems: Problems): void {
  if (!isSkillName(role.name)) {
    problems.add({ file, message: "is in a skill folder whose name is not a skill name (lowercase letters, digits and hyphens)" });
    return;
  }
  if (utf8Bytes(source) > SKILL_FILE_MAX_BYTES) {
    problems.add({ file, message: `is larger than ${SKILL_FILE_MAX_BYTES / 1024} KB` });
    return;
  }
  const leaks = findLeaks(source);
  if (leaks.length) {
    reportLeaks(file, leaks, { line: 1, name: "the skill" }, problems);
    return;
  }
  const skill = parseSkillMd(source);
  if ("error" in skill) {
    problems.add({ file, line: 1, message: `is not a valid SKILL.md: ${skill.error}` });
    return;
  }
  if (skill.name !== role.name) {
    problems.add({ file, line: 2, field: "name", message: `is ${skill.name}, but the skill's folder is named ${role.name}; rename one so they match` });
    return;
  }
  for (const warning of scanSkillText(source)) problems.warn({ file, message: warning });
  parsed.skills.set(file, { file, area: role.area, name: skill.name, description: skill.description, text: source });
}

function resolveBots(parsed: Parsed, problems: Problems): ResolvedBot[] {
  const resolved: ResolvedBot[] = [];
  const names = new Map<string, string>();
  for (const bot of parsed.bots) {
    const area = parsed.areas.get(bot.area);
    if (!area) {
      if (!problems.fileHas(`areas/${bot.area}/area.md`)) problems.add({ file: bot.file, message: `is in areas/${bot.area}/, which has no area.md; add one with kind: area` });
      continue;
    }
    const doc = parsed.docs.get(bot.file)!;
    const name = bot.name.toLowerCase();
    if (names.has(name)) {
      problems.add({ file: bot.file, line: doc.lineOf(["name"]), field: "name", message: `is also the name of ${names.get(name)}; each bot needs its own name` });
      continue;
    }
    names.set(name, bot.file);
    const from: Partial<Record<InheritedField, ProfileLevel>> = {};
    const fields: Record<string, unknown> = {};
    const levels: Array<[ProfileLevel, InheritedFields | undefined]> = [["bot", bot.fields], ["area", area.defaults], ["org", parsed.org?.defaults]];
    for (const field of INHERITED_FIELDS) {
      const nearest = levels.findIndex(([, source]) => source?.[field] !== undefined);
      if (nearest < 0) continue;
      const [level, source] = levels[nearest]!;
      fields[field] = source![field];
      from[field] = level;
    }
    if (fields.tools) {
      checkToolsWidening(parsed, bot, area, levels, from.tools!, problems);
      fields.tools = resolvedTools(fields.tools as ToolScope);
    }
    const skills: ResolvedBot["skills"] = [];
    bot.skills.forEach((entry, index) => {
      const path = joinInside(dirOf(bot.file), entry.file);
      const skill = path === null ? undefined : parsed.skills.get(path);
      const field = `skills[${index}].file`;
      if (problems.has(bot.file, field)) return;
      if (!skill) {
        if (path === null || !problems.fileHas(path)) {
          problems.add({ file: bot.file, line: doc.lineOf(["skills", index, "file"]), field, message: `points to ${path ?? entry.file}, which is not a SKILL.md in an area's skills folder` });
        }
        return;
      }
      if (skills.some((known) => known.name === skill.name)) {
        problems.add({ file: bot.file, line: doc.lineOf(["skills", index, "file"]), field, message: `lists the skill ${skill.name} twice` });
        return;
      }
      skills.push({ name: skill.name, file: skill.file, enabled: entry.enabled });
    });
    resolved.push({
      id: `${bot.area}/${bot.key}`, area: bot.area, key: bot.key, file: bot.file, name: bot.name,
      ...(bot.was ? { was: bot.was } : {}), ...(bot.title !== undefined ? { title: bot.title } : {}), ...(bot.description !== undefined ? { description: bot.description } : {}),
      soul: bot.soul, chief: area.chief === bot.key,
      mcpServers: [...new Set([...(parsed.org?.mcpServers ?? []), ...area.mcpServers, ...bot.mcpServers])],
      skills, ...(fields as InheritedFields), from,
    });
  }
  return resolved;
}

function checkToolsWidening(parsed: Parsed, bot: BotProfile, area: AreaProfile, levels: ReadonlyArray<[ProfileLevel, InheritedFields | undefined]>,
  level: ProfileLevel, problems: Problems): void {
  const nearest = levels.findIndex(([name]) => name === level);
  if (levels[nearest]![1]!.tools!.allow) return;
  const allowing = levels.slice(nearest + 1).find(([, source]) => source?.tools?.allow);
  if (!allowing) return;
  const fileOf = (name: ProfileLevel) => name === "bot" ? bot.file : name === "area" ? area.file : parsed.org!.file;
  const file = fileOf(level);
  const field = level === "bot" ? "tools" : "defaults.tools";
  if (problems.has(file, field)) return;
  problems.add({ file, line: parsed.docs.get(file)?.lineOf(level === "bot" ? ["tools"] : ["defaults", "tools"]), field,
    message: `has no allow, so it would allow every other tool, not only those ${fileOf(allowing[0])} allows; list them in allow, or write allow: ["*"] to allow every tool on purpose` });
}

function resolvedTools(tools: ToolScope): ToolScope {
  if (tools.allow?.[0] !== EVERY_TOOL) return tools;
  return tools.deny ? { deny: tools.deny } : {};
}

function checkApprovalCeilings(parsed: Parsed, bots: ResolvedBot[], problems: Problems): void {
  const rank = (mode: ProfileApproval) => PROFILE_APPROVALS.indexOf(mode);
  const highest = PROFILE_APPROVALS[PROFILE_APPROVALS.length - 1]!;
  const unsetReported = new Set<string>();
  for (const bot of bots) {
    const area = parsed.areas.get(bot.area)!;
    const ceilings = [[area.maxApproval, area.file], [parsed.org?.maxApproval, parsed.org?.file]] as const;
    if (!bot.approval) {
      const [ceiling, ceilingFile] = ceilings.find(([ceiling]) => ceiling && ceiling !== highest) ?? [];
      if (!ceiling || !ceilingFile || unsetReported.has(ceilingFile)) continue;
      unsetReported.add(ceilingFile);
      problems.add({ file: ceilingFile, line: parsed.docs.get(ceilingFile)?.lineOf(["maxApproval"]), field: "maxApproval",
        message: `is ${ceiling}, but no level sets approval for ${bot.id}, so the app's default, Full access, would apply; set approval, such as defaults: { approval: ${ceiling} }` });
      continue;
    }
    for (const [ceiling, ceilingFile] of ceilings) {
      if (!ceiling || rank(bot.approval) <= rank(ceiling)) continue;
      const level = bot.from.approval!;
      const file = level === "bot" ? bot.file : level === "area" ? area.file : parsed.org!.file;
      const path = level === "bot" ? ["approval"] : ["defaults", "approval"];
      const forBot = level === "bot" ? "" : ` for ${bot.id}`;
      problems.add({ file, line: parsed.docs.get(file)?.lineOf(path), field: level === "bot" ? "approval" : "defaults.approval",
        message: `is ${bot.approval}${forBot}, above the most ${ceilingFile} allows (maxApproval: ${ceiling})` });
      break;
    }
  }
}

function checkReferences(parsed: Parsed, listed: readonly string[], problems: Problems): void {
  for (const area of parsed.areas.values()) {
    if (area.chief && !parsed.bots.some((bot) => bot.area === area.key && bot.key === area.chief)) {
      const chiefFile = `areas/${area.key}/bots/${area.chief}.md`;
      const state = listed.includes(chiefFile) || problems.fileHas(chiefFile) ? "is not a valid bot yet; fix its problems first" : "does not exist";
      problems.add({ file: area.file, line: parsed.docs.get(area.file)?.lineOf(["chief"]), field: "chief", message: `names ${area.chief}, but ${chiefFile} ${state}` });
    }
  }
  const warned = new Set<string>();
  const holders = [...(parsed.org ? [parsed.org] : []), ...parsed.areas.values(), ...parsed.bots];
  for (const { file, mcpServers } of holders) {
    mcpServers.forEach((name, index) => {
      if (parsed.mcpServers.has(name) || warned.has(name) || problems.fileHas(`mcp/${name}.md`)) return;
      warned.add(name);
      problems.warn({ file, line: parsed.docs.get(file)?.lineOf(["mcpServers", index]), field: `mcpServers[${index}]`,
        message: `names ${name}, which is not defined under mcp/, so each person's app must already have a server with that name` });
    });
  }
}

/** Reads every profile file of a folder (paths relative to its root, `/`-separated, text already decoded) into the
 * organization, its areas, their bots with every inherited field resolved, the MCP servers and the skills. Nothing here
 * reads a secret's value: secrets stay named slots. `listed` is every profile file the folder has, read or not. */
export function checkProfileFiles(files: ReadonlyArray<{ path: string; text: string }>, listed: readonly string[] = files.map((file) => file.path)): ProfileFolder {
  const problems = new Problems();
  const parsed: Parsed = { areas: new Map(), bots: [], mcpServers: new Map(), skills: new Map(), docs: new Map() };
  const roles = files.map((file) => ({ ...file, role: profileFileRole(file.path) }));
  for (const file of roles) {
    if (!file.role) {
      problems.warn({ file: file.path, message: "is not a profile file, so it is ignored" });
      continue;
    }
    if (file.role.role === "area" && !PROFILE_KEY.test(file.role.area)) {
      problems.add({ file: file.path, message: `is in a folder whose name is not an area key: it ${KEY_RULE}` });
      continue;
    }
    if (file.role.role === "bot" && !PROFILE_KEY.test(file.role.key)) {
      problems.add({ file: file.path, message: `has a file name that is not a bot key: it ${KEY_RULE}` });
      continue;
    }
    const source = file.text.charCodeAt(0) === 0xfeff ? file.text.slice(1) : file.text;
    parseOne(file.path, source.replace(/\r\n?/g, "\n"), file.role, parsed, problems);
  }
  if (!listed.some((path) => ["area", "org"].includes(profileFileRole(path)?.role ?? ""))) {
    problems.add({ file: ".", message: "has no profiles: expected org.md or areas/<key>/area.md (docs/profiles.md)" });
  }
  if (parsed.areas.size > PROFILE_MAX_AREAS) problems.add({ file: "areas", message: `has more than ${PROFILE_MAX_AREAS} areas` });
  if (parsed.bots.length > PROFILE_MAX_BOTS) problems.add({ file: "areas", message: `has more than ${PROFILE_MAX_BOTS} bots` });
  if (parsed.mcpServers.size > PROFILE_MAX_MCP_SERVERS) problems.add({ file: "mcp", message: `has more than ${PROFILE_MAX_MCP_SERVERS} servers` });
  const bots = resolveBots(parsed, problems);
  checkReferences(parsed, listed, problems);
  checkApprovalCeilings(parsed, bots, problems);
  const byPath = (a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file);
  return {
    ...(parsed.org ? { org: parsed.org } : {}),
    areas: [...parsed.areas.values()].sort(byPath),
    bots: bots.sort(byPath),
    mcpServers: [...parsed.mcpServers.values()].sort(byPath),
    skills: [...parsed.skills.values()].sort(byPath),
    problems: problems.list,
    warnings: problems.warnings,
  };
}
