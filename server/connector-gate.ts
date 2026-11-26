// One connector tool call made outside a bot's turn, by something the bot made that declared the tools it calls (a bot's
// page today). Security invariant: such a call is never allowed more than the bot's own turn would be. It runs only a tool
// the caller declared by exact name; only on a connected app or MCP server the bot is granted, with the same grant checks a
// turn's call meets; only with the calling person's own connection, chosen here and never named by the caller; and a tool
// that changes something only when its own listing does not say it reads, the person clicked just now, and the bot's
// access level would let a turn run it without asking. Nothing that would ask is turned into a question here: it is
// refused with the reason.
import { APP_LIMITS, type AppConnectorUse } from "../shared/app.ts";
import { pageConnectorUndeclared } from "../shared/app-frame/bridge.ts";
import { accountLimit, connectorAccessDecision } from "../shared/connector-scopes.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { allowsTool, canUseMcpServer } from "../shared/tool-scope.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";
import { rowRate } from "./chat-apps.ts";
import { toolData } from "./connected-reads.ts";
import { parseMcpResponse } from "./connector-tools-list.ts";
import { modelVisible } from "./mcp-app-observer.ts";
import { connectorScopeRefusalText, evaluateConnectorTools } from "./connector-verdict.ts";
import type { DecisionRow } from "./decision-log.ts";
import { sendsWithoutAsking } from "./outbound-hold.ts";
import { appFrame } from "./skill-burger/executors.ts";
import type { BotRecord } from "./store.ts";
import { appLabel } from "./team-connections.ts";

type Json = Record<string, unknown>;

export type ConnectorTarget = { connector: string; tool: string } | { server: string; tool: string };

/** The bot fields the gate judges a call by, read again just before the call is sent. */
export type GateBot = Pick<BotRecord, "id" | "name" | "composio" | "connectorTools" | "connectorScopes" | "outbound" | "toolScope">;

export type GateRefusal =
  | "not-declared" | "not-granted" | "not-connected" | "needs-access" | "needs-click" | "rate-limited" | "too-large" | "timeout" | "tool-failed" | "unavailable";

export type GateAnswer = { ok: true; result: unknown; truncated?: true } | { ok: false; reason: GateRefusal; status: number; message: string };

/** Who calls, and for whom. */
export interface ConnectorCaller {
  botId: string;
  /** The person whose own connections a call uses where each person connects their own (a Team Cloud); null elsewhere. */
  person: string | null;
  /** The tools this caller declared, by exact name. */
  declared: readonly AppConnectorUse[];
  /** Whether a turn of this bot, where the call comes from, would run a change without asking: Full access. */
  fullAccess(): boolean;
  /** The person clicked in what made the call just now, as the host saw it. */
  engaged: boolean;
  /** `label` names the caller in the audit line ("page m1"); `key` is its own rate limit; `threadId` the conversation it is
   * in, when it is in one. */
  audit: { label: string; key: string; threadId?: string };
  /** What the person reads the caller as, in a refusal: "this page" unless given. */
  what?: string;
}

/** One installation of the connected apps: this computer's or the team's, or a person's own. */
export interface AppInstallation {
  /** One id per installation: a transport session is reused only there. */
  id: string;
  connected(): Promise<Record<string, { connected: boolean; accounts?: ReadonlyArray<{ id: string; status: string }> }>>;
  /** The real service slugs, so an underscored app (bland_ai) is not read as another (bland). */
  serviceSlugs(): Promise<readonly string[]>;
  /** The tools whose own listing marks them read-only (annotations.readOnlyHint, not destructive). */
  readOnlyTools(): Promise<ReadonlySet<string>>;
  relay(frame: Json, session: string | undefined, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
}

export interface GateApps {
  configured(): boolean;
  /** Where `person`'s calls of `toolkit` go, or null when they have no such installation. */
  installation(person: string | null, toolkit: string): AppInstallation | null;
  /** The organisation's rules' refusal of these tools, if any. */
  policyRefusal(slugs: readonly string[], serviceSlugs: readonly string[]): string | undefined;
  /** The app's name as people read it ("Gmail"). */
  label?(toolkit: string): string;
}

/** An MCP server as the bot's own turns would mount it, outside a turn. */
export interface OpenedServer {
  label: string;
  tools(signal: AbortSignal): Promise<Json[]>;
  /** The tool's answer, or the server's own error text, cleaned of anything configured or secret-shaped. */
  call(tool: string, args: Json, signal: AbortSignal): Promise<{ ok: true; body: Json } | { ok: false; text: string }>;
}

export interface GateServers {
  open(bot: GateBot, person: string | null, name: string): Promise<{ ok: true; server: OpenedServer } | { ok: false; reason: "not-granted" | "not-connected"; label: string }>;
}

export interface ConnectorGateDeps {
  bot(id: string): GateBot | undefined;
  apps?: GateApps;
  servers?: GateServers;
  decide(row: Omit<DecisionRow, "at">): void;
  log?(line: string): void;
  now?(): number;
  /** Overrides APP_LIMITS.pageConnectorMs. */
  callMs?: number;
}

export interface ConnectorListing {
  connector?: string;
  server?: string;
  label: string;
  connected: boolean;
  tools: string[];
}

export interface ConnectorGate {
  call(caller: ConnectorCaller, target: ConnectorTarget, args: unknown): Promise<GateAnswer>;
  /** The caller's declared tools, with whether the person has each connected now. */
  list(caller: ConnectorCaller): Promise<ConnectorListing[]>;
}

const SESSION_MS = 10 * 60_000;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

/** The answer within `limit` JSON bytes: a list, or an object's longest list, loses items from its end; anything else
 * becomes its JSON text, cut. */
export function fitResult(value: unknown, limit: number): { value: unknown; truncated: boolean } {
  if (bytesOf(value) <= limit) return { value, truncated: false };
  const shorten = (list: unknown[], rebuild: (kept: unknown[]) => unknown): unknown => {
    let low = 0, high = list.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (bytesOf(rebuild(list.slice(0, mid))) <= limit) low = mid; else high = mid - 1;
    }
    const kept = rebuild(list.slice(0, low));
    return bytesOf(kept) <= limit ? kept : undefined;
  };
  if (Array.isArray(value)) {
    const kept = shorten(value, (items) => items);
    if (kept !== undefined) return { value: kept, truncated: true };
  } else if (isRecord(value)) {
    const longest = Object.entries(value).filter(([, field]) => Array.isArray(field)).sort(([, a], [, b]) => bytesOf(b) - bytesOf(a))[0];
    if (longest) {
      const kept = shorten(longest[1] as unknown[], (items) => ({ ...value, [longest[0]]: items }));
      if (kept !== undefined) return { value: kept, truncated: true };
    }
  }
  const text = JSON.stringify(value) ?? "";
  let cut = text.slice(0, limit);
  while (Buffer.byteLength(cut) > limit) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return { value: cut, truncated: true };
}

/** A tool's own failure text, as a page may show it. */
function failureText(label: string, text: string): string {
  const own = clip(redactSecretsInText(text).replace(/\s+/g, " ").trim(), APP_LIMITS.pageConnectorErrorChars);
  return own ? `${label} said: ${own}` : `${label} could not do that.`;
}

/** The text an MCP tools/call result carries. */
function contentText(result: Json): string {
  return (Array.isArray(result.content) ? result.content : []).flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

const refusal = (reason: GateRefusal, status: number, message: string): GateAnswer => ({ ok: false, reason, status, message });

export function createConnectorGate(deps: ConnectorGateDeps): ConnectorGate {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(`connector gate: ${line}`));
  const callerRate = rowRate(APP_LIMITS.pageConnectorCallsPerMinute, 60_000);
  const connectorRate = rowRate(APP_LIMITS.connectorCallsPerMinute, 60_000);
  const sessions = new Map<string, { id: string | undefined; at: number }>();
  const callMs = deps.callMs ?? APP_LIMITS.pageConnectorMs;
  const appLabelOf = (toolkit: string) => deps.apps?.label?.(toolkit) ?? appLabel(toolkit);

  /** `sent`: the call passed every check and went out, so it is recorded as allowed whatever came back. */
  const audit = (caller: ConnectorCaller, bot: GateBot | undefined, target: ConnectorTarget, answer: GateAnswer, started: number, sent: boolean): GateAnswer => {
    const where = "server" in target ? `mcp:${target.server}` : target.connector;
    // Every call is recorded; its arguments and answer never are.
    log(`${caller.audit.label} bot=${caller.botId} ${where} tool=${target.tool.slice(0, 128)} → ${answer.ok ? "ok" : answer.reason} ${now() - started}ms`);
    deps.decide({
      threadId: caller.audit.threadId ?? "",
      botId: caller.botId,
      ...(bot ? { botName: bot.name } : {}),
      tool: target.tool,
      summary: `${caller.audit.label}: ${answer.ok ? "ran" : sent ? `ran, ${answer.reason}` : answer.reason} (${where})`.slice(0, 240),
      decision: answer.ok || sent ? "auto-approved" : "auto-denied",
      source: "connector-scope",
      rule: `outside-turn:${where}`,
    });
    return answer;
  };

  /** Would a turn of this bot run a change without asking? A send also follows the bot's own sending rule. */
  const accessRefusal = (caller: ConnectorCaller, bot: GateBot, label: string, sends: boolean): string | null => {
    const what = caller.what ?? "this page";
    if (!caller.fullAccess()) {
      return `${bot.name} asks before it changes anything, so ${what} can only read ${label}. Ask ${bot.name} in the chat to do it, or set ${bot.name} to Full access.`;
    }
    if (sends && !sendsWithoutAsking(bot.outbound, true, false)) {
      return `${bot.name} asks before it sends anything for you, so ${what} cannot send through ${label}. Ask ${bot.name} in the chat to send it.`;
    }
    return null;
  };

  const NEEDS_CLICK = (caller: ConnectorCaller, label: string) => `This changes something in ${label}, so it runs only right after the person clicks in ${caller.what ?? "this page"}.`;

  /** The bot's grant for one Composio tool, as the turn's relay judges it; null when granted. */
  const appGrantRefusal = (bot: GateBot | undefined, tool: string, toolkit: string, account: string | undefined, slugs: readonly string[]): string | null => {
    const label = appLabelOf(toolkit);
    if (!bot || bot.composio === false || !deps.apps?.configured() || !canUseMcpServer(bot.toolScope, "composio")) return `${bot?.name ?? "This bot"} cannot use connected apps.`;
    const policy = deps.apps.policyRefusal([tool], slugs);
    if (policy) return policy;
    if (!evaluateConnectorTools([tool], bot.connectorTools as Record<string, ConnectorToolGrant> | undefined, slugs).allowed) {
      return `${bot.name} is not allowed ${tool} in ${label}. The person can allow it in ${bot.name}'s Apps settings.`;
    }
    const access = connectorAccessDecision(bot.connectorScopes, [{ slug: tool, ...(account ? { account } : {}) }], slugs);
    if (!access.ok && access.reason !== "account") return connectorScopeRefusalText({ kind: "tools", invoked: tool, names: [tool] }, access.reason, bot.name, label, tool);
    return null;
  };

  async function session(installation: AppInstallation, signal: AbortSignal, fresh: boolean): Promise<string | undefined> {
    const kept = sessions.get(installation.id);
    if (!fresh && kept && now() - kept.at < SESSION_MS) return kept.id;
    const init = await installation.relay({
      jsonrpc: "2.0", id: "omb-gate-init", method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-pages", version: "1" } },
    }, undefined, signal);
    if (init.status !== 200) throw new Error(`connected apps answered HTTP ${init.status}`);
    // Streamable-HTTP MCP servers expect the initialized notification before the first request.
    await installation.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, init.transportSessionId, signal).catch(() => undefined);
    sessions.set(installation.id, { id: init.transportSessionId, at: now() });
    if (sessions.size > 100) for (const [id, entry] of sessions) if (now() - entry.at >= SESSION_MS) sessions.delete(id);
    return init.transportSessionId;
  }

  async function callApp(caller: ConnectorCaller, target: { connector: string; tool: string }, args: Json, signal: AbortSignal, sent: () => void): Promise<GateAnswer> {
    const { connector: toolkit, tool } = target;
    const label = appLabelOf(toolkit);
    const bot = deps.bot(caller.botId);
    const installation = deps.apps?.configured() ? deps.apps.installation(caller.person, toolkit) : null;
    const slugs = installation ? await installation.serviceSlugs().catch(() => [] as readonly string[]) : [];
    const granted = appGrantRefusal(bot, tool, toolkit, undefined, slugs);
    if (granted) return refusal("not-granted", 403, granted);
    if (!installation) return refusal("not-connected", 409, `Connect ${label} in Apps first.`);
    let services: Awaited<ReturnType<AppInstallation["connected"]>>;
    try { services = await installation.connected(); } catch { return refusal("unavailable", 503, "Connected apps can't be reached right now. Try again in a few minutes."); }
    const state = Object.hasOwn(services, toolkit) ? services[toolkit] : undefined;
    const active = (state?.accounts ?? []).filter((one) => /^active$/i.test(one.status)).map((one) => one.id);
    if (!state?.connected) return refusal("not-connected", 409, `Connect ${label} in Apps first.`);
    // The account is chosen here, as the bot's own reads choose it: one the bot may use, else the newest active one.
    const allowed = accountLimit(bot!.connectorScopes, toolkit);
    const account = allowed ? active.find((id) => allowed.includes(id)) : active.length > 1 ? active[0] : undefined;
    if (allowed && !account) return refusal("not-connected", 409, `Connect the ${label} account ${bot!.name} may use in Apps first.`);
    const readOnly = (await installation.readOnlyTools().catch(() => new Set<string>())).has(tool);
    if (!readOnly) {
      const refused = accessRefusal(caller, bot!, label, isOutboundTool(tool));
      if (refused) return refusal("needs-access", 403, refused);
      if (!caller.engaged) return refusal("needs-click", 403, NEEDS_CLICK(caller, label));
    }
    // The bot as it is now, just before the call goes out: a grant taken away meanwhile wins.
    const again = appGrantRefusal(deps.bot(caller.botId), tool, toolkit, account, slugs);
    if (again) return refusal("not-granted", 403, again);
    const { frame } = appFrame(tool, args, account, Math.floor(Math.random() * 1e9));
    const send = async (fresh: boolean) => {
      const transport = await session(installation, signal, fresh);
      sent();
      return installation.relay(frame, transport, signal);
    };
    let relayed = await send(false);
    // A call that may have changed something is never sent twice.
    if (relayed.status !== 200 && readOnly) relayed = await send(true);
    if (relayed.status !== 200) return refusal("unavailable", 502, `${label} could not be reached. Try again in a moment.`);
    const answer = parseMcpResponse(new TextDecoder().decode(relayed.bytes), frame.id);
    if (!answer) return refusal("unavailable", 502, `${label} sent no answer.`);
    const error = isRecord(answer.error) ? answer.error.message : undefined;
    if (typeof error === "string") return refusal("tool-failed", 502, failureText(label, error));
    const result = isRecord(answer.result) ? answer.result : {};
    if (result.isError === true) return refusal("tool-failed", 502, failureText(label, contentText(result)));
    try {
      return { ok: true, result: toolData(tool, answer) };
    } catch (failure) {
      const text = contentText(result);
      let json = true;
      try { JSON.parse(text); } catch { json = false; }
      if (text && !json) return { ok: true, result: text };
      return refusal("tool-failed", 502, failureText(label, failure instanceof Error ? failure.message : String(failure)));
    }
  }

  async function callServer(caller: ConnectorCaller, target: { server: string; tool: string }, args: Json, signal: AbortSignal, sent: () => void): Promise<GateAnswer> {
    const { server: name, tool } = target;
    const bot = deps.bot(caller.botId);
    const toolGranted = (one: GateBot | undefined) => Boolean(one && canUseMcpServer(one.toolScope, name) && allowsTool(one.toolScope, { kind: "mcp", server: name, name: tool }));
    if (!deps.servers || !bot || !toolGranted(bot)) return refusal("not-granted", 403, `${bot?.name ?? "This bot"} is not allowed ${tool} on ${name}. The person can allow it in its tool settings.`);
    const opened = await deps.servers.open(bot, caller.person, name);
    if (!opened.ok) {
      return opened.reason === "not-granted"
        ? refusal("not-granted", 403, `${bot.name} does not use ${opened.label}.`)
        : refusal("not-connected", 409, `Connect ${opened.label} in Settings first.`);
    }
    const { server } = opened;
    let tools: Json[];
    try { tools = await server.tools(signal); } catch { return refusal("unavailable", 503, `${server.label} can't be reached right now.`); }
    const definition = tools.find((one) => one.name === tool);
    // A tool only an MCP server's own app may call is not one of the bot's tools.
    if (!definition || !modelVisible(definition)) return refusal("not-granted", 403, `${server.label} has no tool ${tool} for ${bot.name}.`);
    const annotations = isRecord(definition.annotations) ? definition.annotations : {};
    if (annotations.readOnlyHint !== true) {
      const refused = accessRefusal(caller, bot, server.label, false);
      if (refused) return refusal("needs-access", 403, refused);
      if (!caller.engaged) return refusal("needs-click", 403, NEEDS_CLICK(caller, server.label));
    }
    if (!toolGranted(deps.bot(caller.botId))) return refusal("not-granted", 403, `${bot.name} is no longer allowed ${tool} on ${name}.`);
    sent();
    const answer = await server.call(tool, args, signal);
    if (!answer.ok) return refusal("tool-failed", 502, failureText(server.label, answer.text));
    if (answer.body.isError === true) return refusal("tool-failed", 502, failureText(server.label, contentText(answer.body)));
    return { ok: true, result: answer.body.structuredContent !== undefined ? answer.body.structuredContent : contentText(answer.body) };
  }

  async function call(caller: ConnectorCaller, target: ConnectorTarget, args: unknown): Promise<GateAnswer> {
    const started = now();
    const bot = deps.bot(caller.botId);
    let sent = false;
    const done = (answer: GateAnswer) => audit(caller, bot, target, answer, started, sent);
    const declared = caller.declared.some((group) => ("server" in target
      ? "server" in group && group.server === target.server
      : "connector" in group && group.connector === target.connector) && group.tools.includes(target.tool));
    if (!declared) return done(refusal("not-declared", 409, pageConnectorUndeclared(target)));
    if (args !== undefined && !isRecord(args)) return done(refusal("too-large", 400, "A connector call's arguments are one object."));
    const given = (args ?? {}) as Json;
    if (bytesOf(given) > APP_LIMITS.pageConnectorArgsBytes) return done(refusal("too-large", 413, `A connector call's arguments are at most ${APP_LIMITS.pageConnectorArgsBytes} bytes of JSON.`));
    const where = "server" in target ? `mcp:${target.server}` : target.connector;
    const at = now();
    if (!callerRate.take(caller.audit.key, at)) return done(refusal("rate-limited", 429, `Too many calls from ${caller.what ?? "this page"}. Wait a minute.`));
    if (!connectorRate.take(`${caller.botId}\u0000${where}`, at)) {
      return done(refusal("rate-limited", 429, `Too many calls to ${"server" in target ? target.server : appLabelOf(target.connector)} from ${caller.what ?? "this page"}'s bot. Wait a minute.`));
    }
    const signal = AbortSignal.timeout(callMs);
    // The time limit holds for every read the checks make too, not only for the call itself.
    const expired = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const went = () => { sent = true; };
    try {
      const answer = await Promise.race([
        "server" in target ? callServer(caller, target, given, signal, went) : callApp(caller, target, given, signal, went),
        expired,
      ]);
      if (!answer.ok) return done(answer);
      const fitted = fitResult(answer.result, APP_LIMITS.pageConnectorResultBytes);
      return done({ ok: true, result: fitted.value, ...(fitted.truncated ? { truncated: true as const } : {}) });
    } catch (error) {
      if (signal.aborted) return done(refusal("timeout", 504, `The call ran past ${Math.round(callMs / 1000)} seconds.`));
      log(`${caller.audit.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      return done(refusal("unavailable", 502, "That connected app could not be reached. Try again in a moment."));
    }
  }

  async function list(caller: ConnectorCaller): Promise<ConnectorListing[]> {
    const bot = deps.bot(caller.botId);
    return Promise.all(caller.declared.map(async (group): Promise<ConnectorListing> => {
      if ("server" in group) {
        const opened = bot && deps.servers ? await deps.servers.open(bot, caller.person, group.server).catch(() => null) : null;
        return { server: group.server, label: opened?.ok ? opened.server.label : opened?.label ?? group.server, connected: opened?.ok === true, tools: [...group.tools] };
      }
      const installation = deps.apps?.configured() ? deps.apps.installation(caller.person, group.connector) : null;
      const services = installation ? await installation.connected().catch(() => null) : null;
      const connected = Boolean(services && Object.hasOwn(services, group.connector) && services[group.connector]?.connected);
      return { connector: group.connector, label: appLabelOf(group.connector), connected, tools: [...group.tools] };
    }));
  }

  return { call, list };
}

/** The gate as a caller with a fixed identity sees it: one call names its declaration, the connected app (or "mcp:<server>")
 * and the tool. */
export function bindConnectorGate(gate: ConnectorGate, caller: Omit<ConnectorCaller, "declared">) {
  return (declaration: readonly AppConnectorUse[], connector: string, tool: string, args: unknown): Promise<GateAnswer> =>
    gate.call({ ...caller, declared: declaration }, connector.startsWith("mcp:") ? { server: connector.slice(4), tool } : { connector, tool }, args);
}
