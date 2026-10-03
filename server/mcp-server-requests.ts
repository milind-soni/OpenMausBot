// propose_mcp_server: a Chief of Staff proposes to add, update, enable,
// disable or remove one custom MCP server. Same shape as profile-requests.ts:
// a Confirm/Cancel card, one validated commit path shared by confirmed cards
// and Full Access submissions, and everything re-validated at confirm time —
// a card can sit open for days. The service never writes config itself:
// index.ts injects the settings routes' own write path and policy check.
//
// Secrets never reach the card. It carries environment and header NAMES and
// whether a client secret is set; the values a bot supplied wait in memory,
// keyed by request id, until the card settles. A restart loses them, and a
// card that needed them then fails closed.
import { createHash } from "node:crypto";

import {
  MCP_SERVER_REQUEST_ACTIONS,
  type McpServerRequestAction,
  type McpServerRequestCardData,
  type McpServerRequestSpec,
} from "../shared/mcp-server-request.ts";
import { newId } from "./contracts.ts";
import {
  MAX_MCP_SERVERS,
  isRemoteMcpServer,
  mcpServerNameError,
  parseMcpServerMutation,
  parseStoredMcpServer,
  type StoredMcpServer,
} from "./mcp-registry.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_REASON = 500;
const ABSENT = "absent";
const STALE = "This MCP server changed after this card was prepared. Ask the bot to review it and propose again.";
const SECRETS_LOST = "The secret values for this card were not kept after a restart. Ask the bot to propose it again.";
const SERVER_FIELDS = ["command", "args", "env", "url", "type", "headers", "oauth"] as const;
const COMMAND_FIELDS = new Set(["command", "args", "env"]);
const EXAMPLES: Record<McpServerRequestAction, string> = {
  add: '{"action":"add","name":"notes","command":"npx","args":["-y","notes-mcp"],"env":{"NOTES_TOKEN":"<value the user gave you>"},"reason":"The user asked to add their notes server."}',
  update: '{"action":"update","name":"docs","url":"https://docs.example.com/mcp","reason":"The user said the server moved."}',
  enable: '{"action":"enable","name":"notes","reason":"The user asked to turn it on."}',
  disable: '{"action":"disable","name":"notes","reason":"The user asked to turn it off."}',
  remove: '{"action":"remove","name":"notes","reason":"The user no longer uses it."}',
};
const ACTION_ALIASES: Record<string, McpServerRequestAction> = {
  create: "add", new: "add", edit: "update", change: "update", modify: "update",
  on: "enable", turn_on: "enable", off: "disable", turn_off: "disable", delete: "remove",
};
const example = (action: McpServerRequestAction) => ` Example: ${EXAMPLES[action]}`;

export interface OptionCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  expired?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  mcpServerRequest?: McpServerRequestCardData;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
export interface McpServerRequestStore {
  messagesFor(threadId: string): Array<{ id: string; card?: OptionCardLike }>;
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options";
      card: OptionCardLike;
      from?: { botId: string; name: string; color: string };
    },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): { id: string } | null;
}

/** What one applied card changed, for the caller's side effects (sign-in invalidation). */
export interface McpServerCommit {
  action: McpServerRequestAction;
  name: string;
  before?: StoredMcpServer;
  after?: StoredMcpServer;
}

export interface McpServerRequestServiceOptions {
  store: McpServerRequestStore;
  /** The configured servers (`cfg.mcpServers`), read fresh at propose and at confirm. */
  servers: () => Record<string, unknown>;
  /** The settings routes' write path. Throws an McpServerRequestError(409)
   * while another MCP settings write holds the lock. */
  commit: (next: Record<string, unknown>, change: McpServerCommit) => void;
  /** Managed organisation policy for an added, updated or enabled server. */
  policyRefusal?: (name: string, server: StoredMcpServer) => string | null | undefined;
  /** Only an active Chief of Staff may propose: a refusal sentence or null. Checked at propose AND confirm. */
  authorize?: (botId: string) => string | null;
  now?: () => number;
  /** Server-owned effective mode of the source conversation, never request input. */
  autoApply?: (botId: string, threadId: string) => boolean;
  canPersist?: (botId: string, threadId: string) => { ok: true } | { ok: false; status: number; error: string };
}

export class McpServerRequestError extends Error {
  readonly status: number;
  /** True when no retry of this card can ever succeed: it must settle as
   * expired instead of staying actionable. */
  readonly terminal: boolean;

  constructor(message: string, status = 400, options?: { terminal?: boolean }) {
    super(message);
    this.name = "McpServerRequestError";
    this.status = status;
    this.terminal = options?.terminal === true;
  }
}

export type ResolveMcpServerRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; action: McpServerRequestAction; name: string; settlementPending?: true; message?: string };

type ProposeArgs = {
  botId: string;
  threadId: string;
  /** The tool input: action, name, reason and, for add/update, server fields. */
  request: unknown;
  from?: { botId: string; name: string; color: string };
};

interface ParsedInput {
  action: McpServerRequestAction;
  name: string;
  reason: string;
  fields: Record<string, unknown>;
}

interface Evaluated {
  existing?: StoredMcpServer;
  server?: StoredMcpServer;
  next: Record<string, unknown>;
  appliedRevision: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

const maskValues = (values: unknown) =>
  isRecord(values) ? Object.fromEntries(Object.keys(values).map((key) => [key, true])) : values;

/** The revision a card pins to: a hash of the stored entry, key order
 * aside, or a sentinel when no entry has that name. The card sits in the
 * transcript next to everything else it hashes, so secret values are masked
 * first: every env and header value, and the client secret, become `true`.
 * Their names stay, so adding or removing a key still moves the revision;
 * a short secret cannot be brute-forced from the card. */
export function mcpServerRevision(entry: unknown): string {
  if (entry === undefined) return ABSENT;
  let masked = entry;
  if (isRecord(entry)) {
    const record: Record<string, unknown> = { ...entry };
    if (record.env !== undefined) record.env = maskValues(record.env);
    if (record.headers !== undefined) record.headers = maskValues(record.headers);
    if (isRecord(record.oauth) && record.oauth.clientSecret !== undefined) record.oauth = { ...record.oauth, clientSecret: true };
    masked = record;
  }
  return createHash("sha256").update(JSON.stringify(canonical(masked)), "utf8").digest("hex");
}

/** Full equality, secret values included. In memory only, never persisted:
 * rotating one env value is a real update even though the revision is the same. */
const sameEntry = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** `cfg.mcpServers` is a plain object: a name like "constructor" must not
 * read through to its prototype. */
const storedEntry = (servers: Record<string, unknown>, name: string) =>
  Object.hasOwn(servers, name) ? servers[name] : undefined;

/** Models stringify nested objects; one obvious meaning is accepted. */
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function stringMap(key: "env" | "headers", value: unknown, action: McpServerRequestAction): Record<string, string> {
  const record = decoded(value);
  const shape = key === "env" ? '{"NOTES_TOKEN":"<value>"}' : '{"Authorization":"Bearer <value>"}';
  if (!isRecord(record)) {
    throw new McpServerRequestError(`${key} must be an object of names to string values, like ${shape}.${example(action)}`);
  }
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(record)) {
    if (typeof item === "string") out[name] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[name] = String(item);
    // Never echo the value: it is very likely a secret.
    else throw new McpServerRequestError(`${key} “${name}” must be a string value, like ${shape}.${example(action)}`);
  }
  return out;
}

function serverFields(raw: Record<string, unknown>, action: McpServerRequestAction): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of SERVER_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === "env" || key === "headers") {
      fields[key] = stringMap(key, value, action);
    } else if (key === "args") {
      const args = decoded(value);
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
        throw new McpServerRequestError(`args must be a list of strings, like ["-y","notes-mcp"].${example(action)}`);
      }
      fields.args = args;
    } else if (key === "oauth") {
      const oauth = decoded(value);
      if (!isRecord(oauth)) {
        throw new McpServerRequestError(`oauth must be an object, like {"clientId":"my-app","scopes":["offline_access"]}.${example(action)}`);
      }
      fields.oauth = oauth.scopes === undefined ? oauth : { ...oauth, scopes: decoded(oauth.scopes) };
    } else if (key === "type") {
      fields.type = typeof value === "string" ? value.trim().toLowerCase() : value;
    } else {
      fields[key] = typeof value === "string" ? value.trim() : value;
    }
  }
  return fields;
}

function reasonText(value: unknown, action: McpServerRequestAction): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new McpServerRequestError(`reason is required: one sentence the user will see.${example(action)}`);
  if (trimmed.length > MAX_REASON) throw new McpServerRequestError(`reason must be ${MAX_REASON} characters or fewer`);
  return redactSecretsInText(trimmed);
}

function parseInput(raw: unknown): ParsedInput {
  if (!isRecord(raw)) throw new McpServerRequestError(`Send one object with action, name and reason.${example("add")}`);
  // enable and disable are actions, so a switch can never ride along with
  // an add or an update and skip the card that says it turns something on.
  if (Object.hasOwn(raw, "enabled")) {
    throw new McpServerRequestError(`There is no enabled field. Use action "enable" or "disable" for the on/off switch.${example("enable")}`);
  }
  const actionText = typeof raw.action === "string" ? raw.action.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const action = (MCP_SERVER_REQUEST_ACTIONS as readonly string[]).includes(actionText)
    ? actionText as McpServerRequestAction
    : ACTION_ALIASES[actionText];
  if (!action) throw new McpServerRequestError(`action must be add, update, enable, disable, or remove.${example("enable")}`);
  for (const key of Object.keys(raw)) {
    if (key !== "action" && key !== "name" && key !== "reason" && !(SERVER_FIELDS as readonly string[]).includes(key)) {
      throw new McpServerRequestError(`Unsupported field: ${key}.${example(action)}`);
    }
  }
  const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
  const nameError = name ? mcpServerNameError(name) : "name is required.";
  if (nameError) throw new McpServerRequestError(`${nameError}${example(action)}`);
  const reason = reasonText(raw.reason, action);
  const fields = serverFields(raw, action);
  const keys = Object.keys(fields);
  if (action !== "add" && action !== "update") {
    if (keys.length) {
      throw new McpServerRequestError(`${action} takes only name and reason. Send server fields with action "update".${example(action)}`);
    }
    return { action, name, reason, fields };
  }
  if (fields.command !== undefined && fields.url !== undefined) {
    throw new McpServerRequestError(`Send command (a local server) or url (a remote server), not both.${example(action)}`);
  }
  if (action === "add" && fields.command === undefined && fields.url === undefined) {
    throw new McpServerRequestError(`An add needs command (a local server) or url (a remote server).${example("add")}`);
  }
  if (action === "update" && !keys.length) {
    throw new McpServerRequestError(`An update needs at least one of command, args, env, url, type, headers, or oauth.${example("update")}`);
  }
  return { action, name, reason, fields };
}

/** Which fields of the other kind were sent, as a teaching refusal. */
function kindError(remote: boolean, fields: Record<string, unknown>, action: McpServerRequestAction): string | null {
  const stray = Object.keys(fields).filter((key) => COMMAND_FIELDS.has(key) === remote);
  if (!stray.length) return null;
  return remote
    ? `${stray.join(", ")} only apply to a local command; a server reached by url takes type, headers, and oauth.${example(action)}`
    : `${stray.join(", ")} only apply to a server reached by url; a local command takes args and env.${example(action)}`;
}

const keepSaved = (values: Record<string, string> | undefined): Record<string, true> =>
  Object.fromEntries(Object.keys(values ?? {}).map((key) => [key, true as const]));

function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * The full mutation an update means: the stored entry's fields of the same
 * kind, with saved env/header values and the client secret passed as the
 * `true` "keep the saved value" placeholders parseMcpServerMutation
 * understands, overlaid with what the bot sent. A bot never sees those
 * values, so it never has to resend them. Switching kind (url for a command
 * server, command for a url server) starts from nothing of the old kind.
 */
function mergedMutation(existing: StoredMcpServer, fields: Record<string, unknown>): Record<string, unknown> {
  const remote = fields.url !== undefined ? true : fields.command !== undefined ? false : isRemoteMcpServer(existing);
  if (!remote) {
    const saved = isRemoteMcpServer(existing) ? undefined : existing;
    return defined({
      command: fields.command ?? saved?.command,
      args: fields.args ?? saved?.args,
      env: { ...keepSaved(saved?.env), ...(fields.env as Record<string, string> | undefined) },
    });
  }
  const saved = isRemoteMcpServer(existing) ? existing : undefined;
  let oauth: unknown;
  if (isRecord(fields.oauth)) {
    // Scopes and the secret carry over only for the same app: a secret
    // never moves to another client ID.
    const sameApp = saved?.oauth && fields.oauth.clientId === saved.oauth.clientId ? saved.oauth : undefined;
    oauth = {
      ...fields.oauth,
      ...(fields.oauth.scopes === undefined && sameApp?.scopes ? { scopes: sameApp.scopes } : {}),
      ...(fields.oauth.clientSecret === undefined && sameApp?.clientSecret ? { clientSecret: true } : {}),
    };
  } else if (saved?.oauth) {
    oauth = defined({ clientId: saved.oauth.clientId, scopes: saved.oauth.scopes, clientSecret: saved.oauth.clientSecret ? true : undefined });
  }
  return defined({
    type: fields.type ?? saved?.type,
    url: fields.url ?? saved?.url,
    headers: { ...keepSaved(saved?.headers), ...(fields.headers as Record<string, string> | undefined) },
    oauth,
  });
}

/** The mutation a confirmation re-parses when no held copy exists: every
 * secret is a keep-the-saved-value placeholder. Only valid for a card whose
 * payload says it needs nothing held. */
function mutationFromSpec(spec: McpServerRequestSpec): Record<string, unknown> {
  if (spec.transport === "command") {
    return { command: spec.command, args: spec.args ?? [], env: Object.fromEntries((spec.envNames ?? []).map((name) => [name, true])) };
  }
  return defined({
    type: spec.transport,
    url: spec.url,
    headers: Object.fromEntries((spec.headerNames ?? []).map((name) => [name, true])),
    oauth: spec.oauth
      ? defined({ clientId: spec.oauth.clientId, scopes: spec.oauth.scopes.length ? spec.oauth.scopes : undefined, clientSecret: spec.oauth.clientSecretSet ? true : undefined })
      : undefined,
  });
}

/** The card's view of a server: free text redacted, secrets by name only. */
function specOf(server: StoredMcpServer): McpServerRequestSpec {
  if (isRemoteMcpServer(server)) {
    return {
      transport: server.type,
      url: redactSecretsInText(server.url),
      headerNames: Object.keys(server.headers).sort(),
      ...(server.oauth ? {
        oauth: {
          clientId: redactSecretsInText(server.oauth.clientId),
          scopes: (server.oauth.scopes ?? []).map((scope) => redactSecretsInText(scope)),
          clientSecretSet: Boolean(server.oauth.clientSecret),
        },
      } : {}),
      enabled: server.enabled,
    };
  }
  return {
    transport: "command",
    command: redactSecretsInText(server.command),
    args: server.args.map((arg) => redactSecretsInText(arg)),
    envNames: Object.keys(server.env).sort(),
    enabled: server.enabled,
  };
}

/** True when the card's spec cannot stand in for the real launch text,
 * because redaction masked part of it. */
function launchRedacted(server: StoredMcpServer, spec: McpServerRequestSpec): boolean {
  if (isRemoteMcpServer(server)) {
    return spec.url !== server.url || (server.oauth !== undefined && (spec.oauth?.clientId !== server.oauth.clientId
      || JSON.stringify(spec.oauth.scopes) !== JSON.stringify(server.oauth.scopes ?? [])));
  }
  return spec.command !== server.command || JSON.stringify(spec.args) !== JSON.stringify(server.args);
}

// Quoted as JSON: verbatim, and on one line, so a newline inside an
// argument cannot forge another line of the card.
const quoted = (value: string | undefined) => JSON.stringify(value ?? "");
const listText = (values: string[] | undefined) => values?.length ? values.join(", ") : "none";

function specFields(spec: McpServerRequestSpec): Array<[string, string]> {
  if (spec.transport === "command") {
    return [
      ["Transport", "local command"],
      ["Command", quoted(spec.command)],
      ["Arguments", spec.args?.length ? spec.args.map(quoted).join(" ") : "none"],
      ["Environment names", listText(spec.envNames)],
    ];
  }
  const fields: Array<[string, string]> = [
    ["Transport", spec.transport],
    ["URL", quoted(spec.url)],
    ["Header names", listText(spec.headerNames)],
  ];
  if (spec.oauth) {
    fields.push(
      ["Sign-in client ID", quoted(spec.oauth.clientId)],
      ["Sign-in scopes", listText(spec.oauth.scopes)],
      ["Client secret supplied", spec.oauth.clientSecretSet ? "yes" : "no"],
    );
  }
  return fields;
}

function changeLines(before: McpServerRequestSpec, after: McpServerRequestSpec): string[] {
  const was = new Map(specFields(before));
  const now = new Map(specFields(after));
  const labels = [...new Set([...was.keys(), ...now.keys()])];
  return labels.filter((label) => was.get(label) !== now.get(label))
    .map((label) => `${label}: ${was.get(label) ?? "none"} → ${now.get(label) ?? "none"}`);
}

function consequence(payload: McpServerRequestCardData): string {
  const local = (payload.after ?? payload.before)?.transport === "command";
  switch (payload.action) {
    case "add":
      return "Saved switched off. Nothing runs.";
    case "enable":
      return local
        ? "Enabling runs this command on the user's computer the next time a bot's turn starts."
        : "Enabling connects bots to this address the next time a bot's turn starts.";
    case "disable":
      return "Bots stop using it from their next turn. Nothing runs.";
    case "remove":
      return "Removes it from every bot.";
    case "update":
      if (!payload.before?.enabled) return "It stays switched off. Nothing runs.";
      return local
        ? "It stays on: the changed command runs on the user's computer the next time a bot's turn starts."
        : "It stays on: bots use the changed connection the next time a bot's turn starts.";
  }
}

const TITLES: Record<McpServerRequestAction, string> = {
  add: "Add MCP server", update: "Change MCP server", enable: "Turn on MCP server", disable: "Turn off MCP server", remove: "Remove MCP server",
};

export function mcpServerCardCopy(payload: McpServerRequestCardData): { title: string; summary: string; detail: string } {
  const title = `${TITLES[payload.action]} “${payload.name}”?`;
  const lines = [`Why: ${payload.reason}`, `Server: ${payload.name}`];
  if (payload.action === "update" && payload.before && payload.after) {
    lines.push(...changeLines(payload.before, payload.after));
    const supplied = [
      ...payload.suppliedSecrets.env.map((name) => `environment ${name}`),
      ...payload.suppliedSecrets.headers.map((name) => `header ${name}`),
      ...(payload.suppliedSecrets.clientSecret ? ["client secret"] : []),
    ];
    if (supplied.length) lines.push(`New secret values supplied for: ${supplied.join(", ")}`);
  } else {
    const spec = payload.after ?? payload.before;
    if (spec) lines.push(...specFields(spec).map(([label, value]) => `${label}: ${value}`));
  }
  lines.push(consequence(payload));
  return { title, summary: `${title} · ${payload.action}`, detail: lines.join("\n") };
}

export class McpServerRequestService {
  private readonly store: McpServerRequestStore;
  private readonly servers: McpServerRequestServiceOptions["servers"];
  private readonly commit: McpServerRequestServiceOptions["commit"];
  private readonly policyRefusal?: McpServerRequestServiceOptions["policyRefusal"];
  private readonly now: () => number;
  private readonly autoApply?: McpServerRequestServiceOptions["autoApply"];
  private readonly canPersist?: McpServerRequestServiceOptions["canPersist"];
  /** Public: a Chief can lose the role between propose and confirm, and
   * tests flip this mid-scenario to model that. */
  authorize?: McpServerRequestServiceOptions["authorize"];
  /** The mutation each open add/update card applies, secret values
   * included. Memory only, by design: never written to the card. */
  private readonly held = new Map<string, { threadId: string; mutation: Record<string, unknown> }>();
  /** Cards applied by this process, so a duplicate confirm never re-applies
   * even after a later change restored the entry the card was prepared on. */
  private readonly applied = new Set<string>();

  constructor(options: McpServerRequestServiceOptions) {
    this.store = options.store;
    this.servers = options.servers;
    this.commit = options.commit;
    this.policyRefusal = options.policyRefusal;
    this.now = options.now ?? Date.now;
    this.autoApply = options.autoApply;
    this.canPersist = options.canPersist;
    this.authorize = options.authorize;
  }

  propose(args: ProposeArgs): { requestId: string; messageId: string; title: string; summary: string; detail: string } {
    return this.prepare(args);
  }

  submit(args: ProposeArgs) {
    const proposal = this.prepare(args, true);
    return { ...proposal, state: proposal.result ? "applied" as const : "pending" as const };
  }

  private refuse(message: string, status: number, terminal: boolean): never {
    throw new McpServerRequestError(message, status, { terminal });
  }

  /** The one validation path, run at propose and again at confirm. At
   * confirm a refusal is terminal unless the user can clear it (a full
   * server list) and confirm the same card again. */
  private evaluate(action: McpServerRequestAction, name: string, mutation: Record<string, unknown> | undefined, confirming: boolean): Evaluated {
    const current = this.servers();
    const stored = storedEntry(current, name);
    const policy = (server: StoredMcpServer) => {
      const refusal = this.policyRefusal?.(name, server);
      if (refusal) this.refuse(refusal, 403, confirming);
    };
    if (action === "add") {
      if (stored !== undefined) this.refuse(`An MCP server named “${name}” already exists. Use action "update" to change it.${example("update")}`, 409, confirming);
      if (Object.keys(current).length >= MAX_MCP_SERVERS) {
        this.refuse(`You can add at most ${MAX_MCP_SERVERS} MCP servers. Ask the user to remove one in MCP server settings first.`, 409, false);
      }
      const parsed = parseMcpServerMutation(name, mutation);
      if (!parsed.ok) this.refuse(`${parsed.error}${example("add")}`, 400, confirming);
      // A new server always lands switched off, as POST /api/mcp/servers and
      // add_mcp_server file it; only an enable card turns it on.
      const server = { ...parsed.server, enabled: false };
      policy(server);
      return { server, next: { ...current, [name]: server }, appliedRevision: mcpServerRevision(server) };
    }
    if (stored === undefined) this.refuse(`No MCP server named “${name}” exists. Use action "add" to file a new one.${example("add")}`, 404, confirming);
    const existing = parseStoredMcpServer(name, stored);
    if (action === "remove") {
      const next = { ...current };
      delete next[name];
      return { existing: existing.ok ? existing.server : undefined, next, appliedRevision: ABSENT };
    }
    if (!existing.ok) {
      this.refuse(`The saved “${name}” entry is not valid (${existing.error}) Ask the user to fix or remove it in MCP server settings.`, 409, confirming);
    }
    let server: StoredMcpServer;
    if (action === "enable" || action === "disable") {
      const enabled = action === "enable";
      if (existing.server.enabled === enabled) this.refuse(`Nothing would change: “${name}” is already ${enabled ? "on" : "off"}.`, 400, confirming);
      server = { ...existing.server, enabled };
    } else {
      const parsed = parseMcpServerMutation(name, mutation, existing.server);
      if (!parsed.ok) this.refuse(`${parsed.error}${example("update")}`, 400, confirming);
      server = parsed.server;
      if (sameEntry(server, existing.server)) {
        this.refuse(`Nothing would change: “${name}” already has these settings.`, 400, confirming);
      }
    }
    // Switching a server off never needs the organisation's approval.
    if (action !== "disable") policy(server);
    return { existing: existing.server, server, next: { ...current, [name]: server }, appliedRevision: mcpServerRevision(server) };
  }

  /** Drop held values whose card settled, was closed, or is gone. */
  private prune(): void {
    for (const [requestId, entry] of this.held) {
      const card = this.store.messagesFor(entry.threadId).find((message) => message.card?.requestId === requestId)?.card;
      if (!card || card.answered || card.expired || card.dismissed) this.held.delete(requestId);
    }
  }

  private prepare(args: ProposeArgs, submitted = false): {
    requestId: string; messageId: string; title: string; summary: string; detail: string;
    result?: Extract<ResolveMcpServerRequestResult, { state: "applied" }>;
  } {
    const input = parseInput(args.request);
    const refusal = this.authorize?.(args.botId);
    if (refusal) throw new McpServerRequestError(refusal, 403);

    const { action, name, fields } = input;
    const stored = storedEntry(this.servers(), name);
    let mutation: Record<string, unknown> | undefined;
    if (action === "add") {
      const error = kindError(fields.url !== undefined, fields, action);
      if (error) throw new McpServerRequestError(error);
      mutation = fields;
    } else if (action === "update") {
      const existing = stored === undefined ? undefined : parseStoredMcpServer(name, stored);
      if (existing?.ok) {
        const remote = fields.url !== undefined ? true : fields.command !== undefined ? false : isRemoteMcpServer(existing.server);
        const error = kindError(remote, fields, action);
        if (error) throw new McpServerRequestError(error);
        mutation = mergedMutation(existing.server, fields);
      }
    }
    const evaluated = this.evaluate(action, name, mutation, false);

    const oauth = isRecord(fields.oauth) ? fields.oauth : undefined;
    const suppliedSecrets = {
      env: Object.keys((fields.env as Record<string, string> | undefined) ?? {}).sort(),
      headers: Object.keys((fields.headers as Record<string, string> | undefined) ?? {}).sort(),
      clientSecret: typeof oauth?.clientSecret === "string",
    };
    const before = evaluated.existing ? specOf(evaluated.existing) : undefined;
    const after = action === "remove" || !evaluated.server ? undefined : specOf(evaluated.server);
    const heldSecrets = Boolean(mutation && evaluated.server && after && (
      suppliedSecrets.env.length || suppliedSecrets.headers.length || suppliedSecrets.clientSecret
      || launchRedacted(evaluated.server, after)));

    const requestId = newId();
    const payload: McpServerRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      action,
      name,
      createdAt: this.now(),
      reason: input.reason,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      suppliedSecrets,
      heldSecrets,
      expectedRevision: mcpServerRevision(stored),
      appliedRevision: evaluated.appliedRevision,
    };
    const copy = mcpServerCardCopy(payload);
    const persistence = this.canPersist?.(args.botId, args.threadId);
    if (persistence && !persistence.ok) throw new McpServerRequestError(persistence.error, persistence.status);
    // Full Access applies only what cannot start anything new: an add (it
    // lands off), a disable, a remove, or an edit of a server that is off.
    // Turning a server on, or changing one that is on, always waits for a
    // human click — the maintainers decided in #2212 that a bot must never
    // turn on a command on the user's computer by itself.
    const startsSomething = action === "enable" || (action === "update" && evaluated.existing?.enabled === true);
    const automatic = submitted && !startsSomething && this.autoApply?.(args.botId, args.threadId) === true;
    this.prune();
    const messageInput: Parameters<McpServerRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: automatic ? [] : ["Confirm", "Cancel"],
        ...(automatic ? { dismissed: true } : {}),
        requestId,
        tool: "propose_mcp_server",
        mcpServerRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    if (mutation) this.held.set(requestId, { threadId: args.threadId, mutation });
    let message: { id: string };
    try {
      message = this.store.appendMessage(args.threadId, messageInput);
    } catch (error) {
      this.held.delete(requestId);
      throw error;
    }
    const proposal = { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
    if (!automatic) return proposal;
    const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
    if (result.state === "applied") return { ...proposal, result };
    // Nobody can confirm a card that was never shown with options.
    this.held.delete(requestId);
    throw new McpServerRequestError(result.state === "invalid" ? result.error : "The MCP server change could not be applied", result.state === "invalid" ? result.status : 409);
  }

  /** The mutation a confirmation applies: the held copy, or one rebuilt
   * from the card when it carried no secret values. */
  private mutationFor(payload: McpServerRequestCardData): Record<string, unknown> | undefined {
    if (payload.action !== "add" && payload.action !== "update") return undefined;
    const held = this.held.get(payload.requestId);
    if (held) return held.mutation;
    if (payload.heldSecrets || !payload.after) throw new McpServerRequestError(SECRETS_LOST, 409, { terminal: true });
    return mutationFromSpec(payload.after);
  }

  /** Claims an MCP server card even after it was settled, so a duplicate
   * click never re-applies an already-applied change. */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveMcpServerRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.mcpServerRequest);
    const card = message?.card;
    const payload = card?.mcpServerRequest;
    if (!message || !card || !payload) return { claimed: false, state: "not_found" };
    if (payload.requestId !== card.requestId) {
      return { claimed: true, state: "invalid", error: "This MCP server request does not match its card", status: 409 };
    }
    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return { claimed: true, state: "invalid", error: "MCP server confirmations must be confirmed or cancelled", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return { claimed: true, state: "invalid", error: "This MCP server request belongs to another conversation", status: 403 };
    }
    if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };

    // Applied already: this process committed it, or the entry is exactly
    // what this card produces (a crash between the write and the card).
    // A secret-only update leaves the masked revision where it was, so the
    // revision proves nothing there: only the in-memory set does, and after
    // a restart such a card needs its held secrets and fails closed anyway.
    // A Cancel of a card this process never applied stays a Cancel.
    const committed = () => this.applied.has(payload.requestId)
      || (payload.appliedRevision !== payload.expectedRevision
        && mcpServerRevision(storedEntry(this.servers(), payload.name)) === payload.appliedRevision);
    try {
      if (this.applied.has(payload.requestId) || (args.behavior === "allow" && committed())) {
        this.held.delete(payload.requestId);
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, mcpServerRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new McpServerRequestError("This MCP server confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      if (card.expired) {
        return { claimed: true, state: "invalid", error: "This MCP server request expired before it was confirmed. Ask for a fresh proposal.", status: 409 };
      }
      if (args.behavior === "deny") {
        this.held.delete(payload.requestId);
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      const refusal = this.authorize?.(payload.botId);
      if (refusal) throw new McpServerRequestError(refusal, 403, { terminal: true });
      if (mcpServerRevision(storedEntry(this.servers(), payload.name)) !== payload.expectedRevision) {
        throw new McpServerRequestError(STALE, 409, { terminal: true });
      }
      const evaluated = this.evaluate(payload.action, payload.name, this.mutationFor(payload), true);
      if (evaluated.appliedRevision !== payload.appliedRevision) throw new McpServerRequestError(STALE, 409, { terminal: true });
      this.commit(evaluated.next, { action: payload.action, name: payload.name, before: evaluated.existing, after: evaluated.server });
      this.applied.add(payload.requestId);
      this.held.delete(payload.requestId);

      const settled = this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined, mcpServerRequest: { ...payload, appliedAt: this.now() } },
      });
      if (!settled) throw new McpServerRequestError("This MCP server confirmation card is no longer available", 409);
      return { claimed: true, state: "applied", action: payload.action, name: payload.name };
    } catch (error) {
      const status = error instanceof McpServerRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const saved = committed();
      // A terminal failure can never be confirmed as prepared: settle the
      // card as expired with its options removed, and forget its secrets.
      const expired = !saved && error instanceof McpServerRequestError && error.terminal;
      if (expired) this.held.delete(payload.requestId);
      const notice = card.dismissed && card.options.length === 0
        ? "MCP server saved. Recording the operation receipt could not finish; the change will not be applied again."
        : "MCP server saved. Confirm again to finish recording this decision; the change will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, ...(expired ? { expired: true, options: [] } : {}), held: saved ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch { /* The committed revision still permits a safe retry. */ }
      if (saved) return { claimed: true, state: "applied", action: payload.action, name: payload.name, settlementPending: true, message: notice };
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
