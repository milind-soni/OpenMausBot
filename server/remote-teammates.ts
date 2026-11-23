// Teammates on other servers: a bot that another OpenMausBot server runs, reached through that server's Bot API
// (docs/bot-api.md) with the key its owner made there. The key is kept in this file alone (mode 600): it is never listed,
// logged or sent anywhere but the Bot API address it was saved with.
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { mkdirSync, readFileSync } from "node:fs";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import type { Agent } from "undici";
import { z } from "zod";

import { addressClass, type AddressClass } from "../electron/egress-addresses.mjs";
import { allowedServerOrigin } from "../electron/server-address.mjs";
import { botApiEndpoint, type BotApiReply } from "../shared/bot-api.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { clip } from "./host/text-clip.ts";
import { parseJson } from "./schema.ts";

export const MAX_REMOTE_TEAMMATES = 50;
/** The Bot API's wait is at most 300 s; past that plus this margin the other server isn't answering. */
const MAX_WAIT_S = 300;
const CALL_MARGIN_MS = 15_000;
/** The connection may stay quiet as long as the longest call: undici's own 300 s header and body timers would end a full wait first. */
const LONGEST_CALL_MS = MAX_WAIT_S * 1000 + CALL_MARGIN_MS;
const CHECK_TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 1_000_000;
const DETAIL_CHARS = 300;

const BOT_ID = /^[\w-]{1,128}$/;
const THREAD_ID = /^[\w-]{1,128}$/;
/** The shape of a key the Bot API card makes; anything else would only be refused by the other server. */
const KEY = /^bak_[\w-]{16,200}$/;
const ENDPOINT_PATH = /^(.*?)\/hooks\/api\/bots\/([^/]+)\/messages\/?$/;
const MAX_BASE_CHARS = 300;
/** No other server answers on these, whatever a name resolves to. */
const NOT_A_SERVER = new Set<AddressClass>(["link-local", "metadata", "reserved"]);
/** This server's own addresses count as any other: a teammate may run on this computer. */
const NONE_OWN = new BlockList();

/** Whether a resolved address is link-local, a cloud metadata service or reserved (also inside NAT64 or 6to4). */
export function notAServerAddress(address: string): boolean {
  return isIP(address.split("%", 1)[0]!) !== 0 && NOT_A_SERVER.has(addressClass(address, NONE_OWN));
}

const onOpenInternet = (address: string): boolean => isIP(address.split("%", 1)[0]!) !== 0 && addressClass(address, NONE_OWN) === "public";

/** Resolves a name as the system does, then refuses it when any address it gives is link-local, metadata or reserved,
 * so a DNS name can't carry a teammate key where a typed address may not go. Runs for every connection a call makes.
 * `privateOnly` is for plain http: a private-network name (`*.local`, `*.ts.net`) that resolves onto the open internet
 * would send the key unencrypted. */
export function serverOnlyLookup(resolve: LookupFunction = dnsLookup as LookupFunction, privateOnly = false): LookupFunction {
  return (hostname, options, callback) => resolve(hostname, options, (error, address, family) => {
    const found = typeof address === "string" ? [address] : (address ?? []).map((entry) => entry.address);
    const refused = error ? undefined : found.find((one) => notAServerAddress(one) || (privateOnly && onOpenInternet(one)));
    if (refused === undefined) return (callback as (...args: unknown[]) => void)(error, address, family);
    const why = notAServerAddress(refused) ? "a link-local, metadata or reserved address, not another server" : "on the open internet, where plain http isn't encrypted";
    callback(Object.assign(new Error(`${hostname} resolves to ${refused}, ${why}`), { code: "ENOTSERVER" }), "", 0);
  });
}

/** One for https, one for plain http (private addresses only). */
const teammateAgents = new Map<boolean, Agent>();
/** fetch whose every connection goes through {@link serverOnlyLookup}. */
async function teammateFetch(url: string, init: RequestInit): Promise<Response> {
  const { Agent: UndiciAgent, fetch: undiciFetch } = await import("undici");
  const plain = new URL(url).protocol === "http:";
  let agent = teammateAgents.get(plain);
  if (!agent) {
    agent = new UndiciAgent({ connect: { lookup: serverOnlyLookup(undefined, plain) }, headersTimeout: LONGEST_CALL_MS, bodyTimeout: LONGEST_CALL_MS });
    teammateAgents.set(plain, agent);
  }
  return undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

const recordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  /** Where the other server's `/hooks` receiver lives: an origin, with a path only if that server is served under one. */
  base: z.string().min(1).max(MAX_BASE_CHARS),
  botId: z.string().regex(BOT_ID),
  key: z.string().regex(KEY),
  createdAt: z.number().finite().nonnegative(),
});
const fileSchema = z.object({ version: z.literal(1), teammates: z.array(recordSchema) });

export type RemoteTeammate = z.output<typeof recordSchema>;
/** What the app may see: never the key. */
export type RemoteTeammateView = Omit<RemoteTeammate, "key">;

export const remoteTeammateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** The other server's address, or the whole Bot API address its card shows. */
  address: z.string().trim().min(1).max(500),
  /** May be left out when the address is the Bot API address, which names the bot. */
  botId: z.string().trim().regex(BOT_ID).optional(),
  key: z.string().trim().regex(KEY, "paste the key the other server's Bot API card showed (it starts with bak_)"),
}).strict();

export class RemoteTeammateError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The base and bot a typed address names. https anywhere; plain http only on this computer or a private network
 * (a LAN address, Tailscale's 100.x or `*.ts.net`, `*.local`), as for the command line's --url. */
export function remoteAddress(address: string, botId?: string): { base: string; botId: string } {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new RemoteTeammateError("that is not a server address; give it like https://maus.example.com", 400);
  }
  // A blob: URL's origin is the https one inside it, so the origin check alone would take it.
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RemoteTeammateError("the address must start with https:// (or http:// on a private network)", 400);
  if (url.username || url.password || url.search || url.hash) throw new RemoteTeammateError("give the server's address without a sign-in, ? or #", 400);
  if (!allowedServerOrigin(url.origin)) {
    throw new RemoteTeammateError(url.protocol === "http:" ? `http://${url.host} is on the open internet and plain http isn't encrypted; use its https:// address` : "the address must start with https:// (or http:// on a private network)", 400);
  }
  if (notAServerAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new RemoteTeammateError(`${url.hostname} is a link-local, metadata or reserved address, not another server`, 400);
  const endpoint = ENDPOINT_PATH.exec(url.pathname);
  const path = (endpoint ? endpoint[1]! : url.pathname).replace(/\/+$/, "");
  // A bot id is only word characters and dashes, so it never needs %-decoding.
  const named = endpoint?.[2];
  if (named !== undefined && !BOT_ID.test(named)) throw new RemoteTeammateError("the bot id in that address isn't valid", 400);
  if (named !== undefined && botId !== undefined && named !== botId) throw new RemoteTeammateError("the address names a different bot than the bot id given", 400);
  const bot = botId ?? named;
  if (!bot) throw new RemoteTeammateError("give the other bot's id, or paste the whole Bot API address from its card", 400);
  const base = `${url.origin}${path}`;
  if (base.length > MAX_BASE_CHARS) throw new RemoteTeammateError("that server address is too long", 400);
  return { base, botId: bot };
}

export interface RemoteTeammatesOptions {
  file?: string;
  now?: () => number;
}

export class RemoteTeammates {
  private readonly file: string;
  private readonly now: () => number;
  private teammates: RemoteTeammate[] = [];
  /** Saves are refused while set, so an empty list never overwrites a file that couldn't be read. */
  private unreadable = false;

  constructor(options: RemoteTeammatesOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "remote-teammates.json");
    this.now = options.now ?? Date.now;
    try {
      const parsed = fileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.teammates = parsed.data.teammates;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unreadable = true;
        console.error(`remote teammates: ignoring unreadable ${this.file}: ${error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unable to read"}`);
      }
    }
  }

  list(): RemoteTeammateView[] {
    return this.teammates.map(view);
  }

  /** With its key: for calling it, never for showing. */
  get(id: string): RemoteTeammate | undefined {
    return this.teammates.find((teammate) => teammate.id === id);
  }

  add(input: z.input<typeof remoteTeammateInputSchema>): RemoteTeammateView {
    this.assertWritable();
    const parsed = remoteTeammateInputSchema.safeParse(input);
    if (!parsed.success) throw new RemoteTeammateError(parsed.error.issues[0]?.message ?? "invalid teammate", 400);
    const { base, botId } = remoteAddress(parsed.data.address, parsed.data.botId);
    if (this.teammates.some((teammate) => teammate.base === base && teammate.botId === botId)) throw new RemoteTeammateError("that bot is already a teammate", 409);
    if (this.teammates.length >= MAX_REMOTE_TEAMMATES) throw new RemoteTeammateError(`at most ${MAX_REMOTE_TEAMMATES} teammates on other servers`, 400);
    const record: RemoteTeammate = { id: randomUUID(), name: parsed.data.name, base, botId, key: parsed.data.key, createdAt: this.now() };
    this.save([...this.teammates, record]);
    return view(record);
  }

  remove(id: string): boolean {
    this.assertWritable();
    const rest = this.teammates.filter((teammate) => teammate.id !== id);
    if (rest.length === this.teammates.length) return false;
    this.save(rest);
    return true;
  }

  private assertWritable(): void {
    if (this.unreadable) throw new RemoteTeammateError("The saved teammates on other servers could not be read. Repair remote-teammates.json and restart OpenMausBot before changing them.", 503);
  }

  /** Writes `teammates` and only then keeps them, so a failed write leaves the list as the file has it. */
  private save(teammates: RemoteTeammate[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, teammates }, null, 2), { mode: 0o600 });
    this.teammates = teammates;
  }
}

function view({ key: _key, ...rest }: RemoteTeammate): RemoteTeammateView {
  return rest;
}

/** Why a call to the other server got no answer to use. `status` is its HTTP status when it gave one. */
export type RemoteProblem =
  | "unreachable" | "bad_answer" | "bad_request" | "wrong_key" | "refused" | "no_thread" | "busy" | "rate_limited" | "failed";

export type RemoteResult =
  | { ok: true; answer: BotApiReply }
  | { ok: false; problem: RemoteProblem; status?: number; detail?: string; retryAfterSeconds?: number };

export interface RemoteCallOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Sends the other bot a message, as any Bot API caller would; `thread` goes on in a thread an earlier answer gave. */
export function sendToRemote(teammate: RemoteTeammate, call: { message: string; thread?: string; wait?: number }, options: RemoteCallOptions = {}): Promise<RemoteResult> {
  const wait = Number.isFinite(call.wait) ? Math.min(MAX_WAIT_S, Math.max(0, call.wait!)) : 50;
  return callRemote(teammate, "", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: call.message, ...(call.thread !== undefined ? { thread: call.thread } : {}), wait }),
  }, Math.ceil(wait * 1000) + CALL_MARGIN_MS, options, call.thread);
}

/** Reads a thread an earlier answer gave: its reply once the other bot is done, or what it is doing now. */
export function readRemote(teammate: RemoteTeammate, thread: string, options: RemoteCallOptions = {}): Promise<RemoteResult> {
  if (!THREAD_ID.test(thread)) return Promise.resolve({ ok: false, problem: "no_thread" });
  return callRemote(teammate, `?thread=${encodeURIComponent(thread)}`, { method: "GET" }, CHECK_TIMEOUT_MS, options, thread);
}

/** Whether the other server takes this key, without starting anything there: a read of a thread that can't exist is
 * answered 404 "no such thread" only after the key was accepted. Any other 404 (a proxy, a path with no Bot API) isn't. */
export async function checkRemote(teammate: RemoteTeammate, options: RemoteCallOptions = {}): Promise<{ ok: true } | Extract<RemoteResult, { ok: false }>> {
  const result = await callRemote(teammate, `?thread=omb-check-${randomUUID()}`, { method: "GET" }, CHECK_TIMEOUT_MS, options);
  if (!result.ok) {
    if (result.problem !== "no_thread") return result;
    return result.detail === "no such thread" ? { ok: true } : { ok: false, problem: "bad_answer", status: 404, ...(result.detail ? { detail: result.detail } : {}) };
  }
  return { ok: false, problem: "bad_answer", status: 200 };
}

/** `thread`: the thread the call goes on in, which its answer must be about; a call that starts one takes the thread it is given. */
async function callRemote(teammate: RemoteTeammate, query: string, init: RequestInit, timeoutMs: number, options: RemoteCallOptions, thread?: string): Promise<RemoteResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    // An IP literal connects without a lookup, so serverOnlyLookup never sees it; a saved address is checked here too.
    const host = new URL(teammate.base).hostname.replace(/^\[|\]$/g, "");
    if (notAServerAddress(host)) throw new Error(`${host} is a link-local, metadata or reserved address, not another server`);
    // A redirect would carry the key to an address nobody saved.
    response = await (options.fetch ?? teammateFetch)(`${botApiEndpoint(teammate.base, teammate.botId)}${query}`, {
      ...init, redirect: "error", signal,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${teammate.key}` },
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = failureReason(error);
    return { ok: false, problem: "unreachable", detail: timeout.aborted ? "no answer in time" : reason === undefined ? undefined : clip(reason, DETAIL_CHARS) };
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(response, signal));
  } catch {
    options.signal?.throwIfAborted();
    if (timeout.aborted) return { ok: false, problem: "unreachable", detail: "no answer in time" };
    // Busy, rate limited or failing means the same whatever the body: a proxy's 502 page, a plain-text 429. Any other
    // answer that isn't JSON (an auth wall's 401 page, a proxy's 404) is not the Bot API's, so says nothing of the key.
    if (response.status !== 409 && response.status !== 429 && response.status < 500) return { ok: false, problem: "bad_answer", status: response.status };
    body = undefined;
  }
  if (response.status === 200 || response.status === 202) {
    const answer = parseAnswer(body, response.status, thread);
    return answer ? { ok: true, answer } : { ok: false, problem: "bad_answer", status: response.status };
  }
  // A server that echoes the key back must not hand it to whoever reads the result; it goes before the clip, so no part is left.
  const said = (body as { error?: unknown } | undefined)?.error;
  const detail = typeof said === "string" ? clip(said.split(teammate.key).join("[key]"), DETAIL_CHARS) : undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    ok: false, problem: PROBLEM_BY_STATUS[response.status] ?? (response.status >= 500 ? "failed" : "bad_answer"), status: response.status,
    ...(detail ? { detail } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.ceil(retryAfter) } : {}),
  };
}

/** fetch says only "fetch failed"; why (refused, no such name, a link-local address) is its cause. A name with more
 * than one address fails with an AggregateError whose message is empty: then its first error or its code says why. */
function failureReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = error.cause as (Error & { code?: unknown; errors?: unknown[] }) | undefined;
  if (!(cause instanceof Error)) return error.message;
  const first = cause.errors?.[0];
  return cause.message || (first instanceof Error ? first.message : undefined) || (typeof cause.code === "string" ? cause.code : undefined) || error.message;
}

const PROBLEM_BY_STATUS: Record<number, RemoteProblem> = {
  400: "bad_request", 401: "wrong_key", 403: "refused", 404: "no_thread", 409: "busy", 413: "bad_request", 415: "bad_request", 429: "rate_limited",
};

/** Only the two shapes docs/bot-api.md promises; a proxy's page or anything else is not an answer. */
function parseAnswer(body: unknown, status: number, expected?: string): BotApiReply | null {
  if (!body || typeof body !== "object") return null;
  const { reply, thread, status: state } = body as Record<string, unknown>;
  if (typeof thread !== "string" || !THREAD_ID.test(thread) || (expected !== undefined && thread !== expected)) return null;
  if (status === 200) return typeof reply === "string" ? { reply, thread } : null;
  return state === "working" || state === "needs_approval" ? { thread, status: state } : null;
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ANSWER_BYTES) throw new Error("answer too large");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
