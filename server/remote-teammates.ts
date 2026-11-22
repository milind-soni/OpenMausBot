// Teammates on other servers: a bot that another OpenMausBot server runs, reached through that server's Bot API
// (docs/bot-api.md) with the key its owner made there. The key is kept in this file alone (mode 600): it is never listed,
// logged or sent anywhere but the Bot API address it was saved with.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { allowedServerOrigin } from "../electron/server-address.mjs";
import { botApiEndpoint, type BotApiReply } from "../shared/bot-api.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { clip } from "./host/text-clip.ts";
import { parseJson } from "./schema.ts";

export const MAX_REMOTE_TEAMMATES = 50;
/** The Bot API's wait is at most 300 s; past that plus this margin the other server isn't answering. */
const CALL_MARGIN_MS = 15_000;
const CHECK_TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 1_000_000;
const DETAIL_CHARS = 300;

const BOT_ID = /^[\w-]{1,128}$/;
const THREAD_ID = /^[\w-]{1,128}$/;
/** The shape of a key the Bot API card makes; anything else would only be refused by the other server. */
const KEY = /^bak_[\w-]{16,200}$/;
const ENDPOINT_PATH = /^(.*?)\/hooks\/api\/bots\/([^/]+)\/messages\/?$/;
const MAX_BASE_CHARS = 300;
/** Link-local hosts (169.254/16, fe80::/10) and the cloud metadata service: never another OpenMausBot server, and a key
 * must not open a way from this server to them. */
const LINK_LOCAL = /^(?:169\.254\.|\[fe[89ab][0-9a-f]:|\[::ffff:a9fe:|\[fd00:ec2::254\]$)/i;

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
  if (url.username || url.password || url.search || url.hash) throw new RemoteTeammateError("give the server's address without a sign-in, ? or #", 400);
  if (!allowedServerOrigin(url.origin)) {
    throw new RemoteTeammateError(url.protocol === "http:" ? `http://${url.host} is on the open internet and plain http isn't encrypted; use its https:// address` : "the address must start with https:// (or http:// on a private network)", 400);
  }
  if (LINK_LOCAL.test(url.hostname)) throw new RemoteTeammateError(`${url.hostname} is a link-local address, not another server`, 400);
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
    if (this.unreadable) throw new RemoteTeammateError("The saved teammates on other servers could not be read. Repair remote-teammates.json before changing them.", 503);
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
  const wait = Number.isFinite(call.wait) ? Math.min(300, Math.max(0, call.wait!)) : 50;
  return callRemote(teammate, "", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: call.message, ...(call.thread !== undefined ? { thread: call.thread } : {}), wait }),
  }, Math.ceil(wait * 1000) + CALL_MARGIN_MS, options);
}

/** Reads a thread an earlier answer gave: its reply once the other bot is done, or what it is doing now. */
export function readRemote(teammate: RemoteTeammate, thread: string, options: RemoteCallOptions = {}): Promise<RemoteResult> {
  if (!THREAD_ID.test(thread)) return Promise.resolve({ ok: false, problem: "no_thread" });
  return callRemote(teammate, `?thread=${encodeURIComponent(thread)}`, { method: "GET" }, CHECK_TIMEOUT_MS, options);
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

async function callRemote(teammate: RemoteTeammate, query: string, init: RequestInit, timeoutMs: number, options: RemoteCallOptions): Promise<RemoteResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    // A redirect would carry the key to an address nobody saved.
    response = await (options.fetch ?? fetch)(`${botApiEndpoint(teammate.base, teammate.botId)}${query}`, {
      ...init, redirect: "error", signal,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${teammate.key}` },
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    return { ok: false, problem: "unreachable", detail: timeout.aborted ? "no answer in time" : error instanceof Error ? clip(error.message, DETAIL_CHARS) : undefined };
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(response, signal));
  } catch {
    options.signal?.throwIfAborted();
    if (timeout.aborted) return { ok: false, problem: "unreachable", detail: "no answer in time" };
    return { ok: false, problem: "bad_answer", status: response.status };
  }
  if (response.status === 200 || response.status === 202) {
    const answer = parseAnswer(body, response.status);
    return answer ? { ok: true, answer } : { ok: false, problem: "bad_answer", status: response.status };
  }
  const detail = typeof (body as { error?: unknown })?.error === "string" ? clip((body as { error: string }).error, DETAIL_CHARS) : undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    ok: false, problem: PROBLEM_BY_STATUS[response.status] ?? (response.status >= 500 ? "failed" : "bad_answer"), status: response.status,
    ...(detail ? { detail } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.ceil(retryAfter) } : {}),
  };
}

const PROBLEM_BY_STATUS: Record<number, RemoteProblem> = {
  400: "bad_request", 401: "wrong_key", 403: "refused", 404: "no_thread", 409: "busy", 413: "bad_request", 415: "bad_request", 429: "rate_limited",
};

/** Only the two shapes docs/bot-api.md promises; a proxy's page or anything else is not an answer. */
function parseAnswer(body: unknown, status: number): BotApiReply | null {
  if (!body || typeof body !== "object") return null;
  const { reply, thread, status: state } = body as Record<string, unknown>;
  if (typeof thread !== "string" || !THREAD_ID.test(thread)) return null;
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
