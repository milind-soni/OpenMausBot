// edu-cloud (https://github.com/EduardoMoraga/edu-cloud) serves an Edu brain over Streamable HTTP MCP at `<base>/mcp`, with
// the same tool names as `edu mcp`. Since its per-person credentials it also answers `GET <base>/api/v1/whoami` and the
// review routes `<base>/api/v1/proposals[/<id>/approve|reject]` (approve and reject for a steward token only); an older
// edu-cloud answers 404 there, and its proposals are decided on the server host.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";

import { eduCloudUrlProblem, type EduBrainSetting, type EduCloudToken, type EduCloudView, type EduProposal } from "../shared/edu-brain.ts";
import { mcpStdioServer } from "./mcp-gate-config.ts";
import { McpHttpError, RemoteMcpClient } from "./mcp-http.ts";
import { AGENTS_NODE_FLAG } from "./proxy-paths.ts";

export type EduCloudSetting = Extract<EduBrainSetting, { mode: "cloud" }>;
export type EduCloudScope = "member" | "steward";
export type EduCloudWhoami = { review: true; label: string; scope: EduCloudScope } | { review: false };
export type EduCloudDecision = "accepted" | "rejected" | "gone" | { status: number; error: string };
export type EduCloudTurn = { threadId?: string; generation?: string };

/** Security: the only address an engine's `edu` server reaches for a cloud brain. It holds a capability of the turn, and
 * Edu Bot adds the person's token here, in its own process, so the token never reaches an MCP config, argv or an engine's
 * environment, where a bot's shell could read it and use it on edu-cloud's review routes. */
export const EDU_CLOUD_RELAY_PATH = "/api/internal/edu/mcp";
const RELAY_REQUEST_HEADERS = ["accept", "mcp-session-id", "mcp-protocol-version"] as const;
const RELAY_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "allow"] as const;
const RELAY_TIMEOUT_MS = 120_000;

const TIMEOUT_MS = 10_000;
const PROPOSAL_ID = /^[A-Za-z0-9][\w.-]{0,199}$/;
const BODY_CHARS = 600;
const WHOAMI_TTL_MS = 60_000;

export const EDU_CLOUD_NO_TOKEN = "Save this person's edu-cloud token in the Vault first.";
export const EDU_CLOUD_NOT_LOCAL = "This bot's Edu brain is on edu-cloud, not on this computer";
export const EDU_CREW_NOT_ON_CLOUD = "Edu crew works only with an Edu brain on this computer, and this bot's is on edu-cloud. Give it its own, an area's or a folder's brain to use Edu crew.";

/** Security: a token is a bearer for the whole team brain, so one with whitespace or too short to be a real one is not
 * sent anywhere. */
export function usableCloudToken(value: string | null | undefined): string | null {
  const token = value?.trim();
  return token && token.length >= 16 && token.length <= 4096 && !/\s/.test(token) ? token : null;
}

export const cloudTokenName = (token: EduCloudToken) => "secret" in token ? token.secret : token.env;

/** `https://host/x/mcp` → `https://host/x`: the review routes sit beside `/mcp`. */
export function cloudBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/mcp$/, "");
}

export interface EduCloudDeps {
  /** This person's token for a bot's brain, or null when none is saved. */
  token(bot: { id: string; threadId?: string }, ref: EduCloudToken): string | null;
  /** Edu Bot's own loopback address, and a capability for the relay that holds only while this turn runs. */
  relay?: { origin: string; mint(bot: { id: string }, turn: Required<EduCloudTurn>): string | null };
  fetch?: typeof fetch;
  now?(): number;
}

type CloudBot = { id: string; threadId?: string; eduBrain?: EduBrainSetting };

/** One MCP JSON-RPC message, or a batch of them. */
function isJsonRpc(body: unknown): boolean {
  const message = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && (value as { jsonrpc?: unknown }).jsonrpc === "2.0";
  return Array.isArray(body) ? body.length > 0 && body.every(message) : message(body);
}

/** Streams the relayed answer back with only the headers MCP needs. */
export async function sendRelayed(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of RELAY_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res).catch(() => res.destroy());
}

export function createEduCloud(deps: EduCloudDeps) {
  const requestTo = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const whoamis = new Map<string, { at: number; value: EduCloudWhoami }>();

  const settingOf = (bot: CloudBot): EduCloudSetting | null => bot.eduBrain?.mode === "cloud" ? bot.eduBrain : null;
  const tokenOf = (bot: CloudBot, setting: EduCloudSetting) => usableCloudToken(deps.token(bot, setting.token));

  async function call(setting: EduCloudSetting, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return requestTo(`${cloudBase(setting.url)}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function failure(response: Response): Promise<string> {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error.slice(0, 300) : `edu-cloud answered ${response.status}`;
  }

  async function whoami(setting: EduCloudSetting, token: string): Promise<EduCloudWhoami> {
    const key = `${setting.url}\0${token}`;
    const cached = whoamis.get(key);
    if (cached && now() - cached.at < WHOAMI_TTL_MS) return cached.value;
    const response = await call(setting, token, "/api/v1/whoami");
    let value: EduCloudWhoami;
    if (response.status === 404) value = { review: false };
    else if (!response.ok) throw new Error(await failure(response));
    else {
      const body = await response.json() as { label?: unknown; scope?: unknown };
      value = { review: true, label: typeof body.label === "string" ? body.label : "", scope: body.scope === "steward" ? "steward" : "member" };
    }
    whoamis.set(key, { at: now(), value });
    return value;
  }

  function proposalsOf(setting: EduCloudSetting, rows: unknown): EduProposal[] {
    if (!Array.isArray(rows)) throw new Error("edu-cloud did not send a list of proposals");
    const proposals: EduProposal[] = [];
    for (const row of rows) {
      const raw = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
      const id = text("id");
      if (!PROPOSAL_ID.test(id)) continue;
      const body = text("body").slice(0, BODY_CHARS + 1);
      proposals.push({ id, title: text("title") || id, kind: text("kind"), band: text("band") || "unbanded", why: text("why"),
        brain: setting.url, global: false, location: setting.url, shared: true, cloud: true, ...(body ? { body } : {}) });
    }
    return proposals;
  }

  return {
    /** The turn's `edu` server: Edu Bot's relay to edu-cloud, through the remote MCP proxy every engine mounts as stdio.
     * Null without a saved token, or outside a running turn. */
    server(bot: CloudBot, turn: EduCloudTurn): { command: string; args: string[]; env: Record<string, string> } | null {
      const setting = settingOf(bot);
      if (!setting || !tokenOf(bot, setting) || !deps.relay || !turn.threadId || !turn.generation) return null;
      let capability: string | null;
      try { capability = deps.relay.mint(bot, { threadId: turn.threadId, generation: turn.generation }); } catch { return null; }
      if (!capability) return null;
      const relay = { type: "http", url: `${deps.relay.origin}${EDU_CLOUD_RELAY_PATH}`, headers: { authorization: `Bearer ${capability}` } };
      const stdio = mcpStdioServer(relay, { nodeEnv: { ...AGENTS_NODE_FLAG } });
      return stdio ? { command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} } : null;
    },

    /** One MCP request from a turn's `edu` server, sent to this bot's edu-cloud `/mcp` with the person's token. Nothing
     * but MCP JSON-RPC (a POST) and the end of a session (a DELETE) goes through, and only to the brain's own address. */
    async relay(bot: CloudBot, request: { method: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, signal?: AbortSignal): Promise<Response> {
      const refuse = (status: number, error: string, headers: Record<string, string> = {}) => Response.json({ error }, { status, headers });
      if (request.method !== "POST" && request.method !== "DELETE") return refuse(405, "method not allowed", { allow: "POST, DELETE" });
      const setting = settingOf(bot);
      if (!setting) return refuse(409, "This bot has no edu-cloud brain any more.");
      const addressProblem = eduCloudUrlProblem(setting.url);
      if (addressProblem) return refuse(409, `This bot's edu-cloud address ${addressProblem}.`);
      const token = tokenOf(bot, setting);
      if (!token) return refuse(409, EDU_CLOUD_NO_TOKEN);
      if (request.method === "POST" && !isJsonRpc(request.body)) return refuse(400, "Only MCP JSON-RPC messages go to edu-cloud here.");
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      for (const name of RELAY_REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string" && value.length <= 1024) headers[name] = value;
      }
      if (request.method === "POST") headers["content-type"] = "application/json";
      const timeout = AbortSignal.timeout(RELAY_TIMEOUT_MS);
      try {
        return await requestTo(setting.url, {
          method: request.method, headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
        });
      } catch (error) {
        return refuse(502, `edu-cloud could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    hasToken(bot: CloudBot): boolean {
      const setting = settingOf(bot);
      return Boolean(setting && tokenOf(bot, setting));
    },

    /** `edu_brief` from the cloud brain, as `edu brief --json` prints a brief. */
    async brief(bot: CloudBot): Promise<string> {
      const setting = settingOf(bot);
      const token = setting && tokenOf(bot, setting);
      if (!setting || !token) throw new Error(EDU_CLOUD_NO_TOKEN);
      const client = new RemoteMcpClient({ type: "http", url: setting.url, headers: { Authorization: `Bearer ${token}` } }, { fetch: (input, init) => requestTo(input, { ...init, redirect: "error" }) });
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      try {
        await client.initialize("Edu Bot", signal);
        const result = await client.request("tools/call", { name: "edu_brief", arguments: {} }, signal) as { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
        if (result?.isError) throw new Error("edu-cloud could not make a brief");
        const text = (result?.content ?? []).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
        return JSON.stringify({ text });
      } finally {
        await client.close().catch(() => {});
      }
    },

    /** What this person's token may do there, for Memory settings. Never throws. */
    async view(bot: CloudBot): Promise<EduCloudView | null> {
      const setting = settingOf(bot);
      if (!setting) return null;
      const base = { url: setting.url, token: cloudTokenName(setting.token) };
      const token = tokenOf(bot, setting);
      if (!token) return { ...base, tokenMissing: true, review: false };
      try {
        const who = await whoami(setting, token);
        return who.review ? { ...base, review: true, label: who.label, scope: who.scope } : { ...base, review: false };
      } catch (error) {
        return { ...base, review: false, error: error instanceof McpHttpError || error instanceof Error ? error.message : String(error) };
      }
    },

    /** Whether this person's token is a steward's on a server with the review routes. */
    async steward(bot: CloudBot): Promise<boolean> {
      const setting = settingOf(bot);
      const token = setting && tokenOf(bot, setting);
      if (!setting || !token) return false;
      const who = await whoami(setting, token).catch(() => null);
      return who?.review === true && who.scope === "steward";
    },

    /** The cloud brain's pending proposals; empty on an older edu-cloud, which has no route for them. */
    async list(bot: CloudBot): Promise<EduProposal[]> {
      const setting = settingOf(bot);
      const token = setting && tokenOf(bot, setting);
      if (!setting || !token) throw new Error(EDU_CLOUD_NO_TOKEN);
      const response = await call(setting, token, "/api/v1/proposals");
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(await failure(response));
      return proposalsOf(setting, ((await response.json()) as { proposals?: unknown }).proposals);
    },

    async decide(bot: CloudBot, id: string, approve: boolean, reason?: string): Promise<EduCloudDecision> {
      const setting = settingOf(bot);
      const token = setting && tokenOf(bot, setting);
      if (!setting || !token) return { status: 409, error: EDU_CLOUD_NO_TOKEN };
      if (!PROPOSAL_ID.test(id)) return { status: 400, error: "That isn't an Edu proposal id." };
      let response: Response;
      try {
        response = await call(setting, token, `/api/v1/proposals/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`,
          { method: "POST", body: reason ? { reason } : {} });
      } catch (error) {
        return { status: 502, error: `edu-cloud could not be reached: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (response.ok) return approve ? "accepted" : "rejected";
      if (response.status === 404) return "gone";
      if (response.status === 403) return { status: 403, error: "Only a steward of this edu-cloud brain can approve or reject its proposals." };
      return { status: 502, error: `edu-cloud couldn't decide this proposal: ${await failure(response)}` };
    },
  };
}

export type EduCloud = ReturnType<typeof createEduCloud>;
