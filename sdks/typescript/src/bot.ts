import { ConflictError, JobFailedError, MausBotError, NotSentError, WaitTimeoutError } from "./errors.js";
import { request, type HttpConfig } from "./http.js";

export type Answer = { status: "replied"; reply: string; thread: string } | { status: "needs_approval"; thread: string };
export type ThreadState = Answer | { status: "working"; thread: string } | { status: "failed"; thread: string; error: string };
export interface BotOptions { endpoint?: string; baseUrl?: string; botId?: string; key?: string; maxRetries?: number; retryDelay?: number; fetch?: typeof fetch }
/** Seconds. */
export interface WaitOptions { timeout?: number; pollInterval?: number }
type SendOptions = { thread?: string; wait?: number };

const NO_ADDRESS = "No bot address: pass `endpoint` (the address on the bot's Bot API card) or set MAUSBOT_BOT_URL.";
const env = (name: string) => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]?.trim() || undefined;
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function normalise(body: unknown): ThreadState {
  const b = (body ?? {}) as Record<string, unknown>;
  const thread = b.thread;
  if (typeof thread !== "string") throw new MausBotError("The server's answer has no thread id");
  if (b.status === undefined && typeof b.reply === "string") return { status: "replied", reply: b.reply, thread };
  if (b.status === "working" || b.status === "needs_approval") return { status: b.status, thread };
  if (b.status === "failed") return { status: "failed", thread, error: typeof b.error === "string" ? b.error : "The bot could not answer." };
  throw new MausBotError(`The server answered with an unknown status: ${JSON.stringify(b.status)}`);
}

export class Bot {
  readonly #http: HttpConfig;
  readonly #path: string;

  constructor(options: BotOptions = {}) {
    const key = (options.key ?? env("MAUSBOT_BOT_KEY"))?.trim();
    if (!key) throw new MausBotError("No key: pass `key` or set MAUSBOT_BOT_KEY.");
    if (!/^[\x21-\x7e]+$/.test(key)) throw new MausBotError("The key has characters a MausBot key never has.");
    const maxRetries = options.maxRetries ?? 2;
    const retryDelay = options.retryDelay ?? 0.5;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new MausBotError("`max_retries` must be a whole number, 0 or more.");
    if (typeof retryDelay !== "number" || !(retryDelay >= 0)) throw new MausBotError("`retry_delay` must be a number of seconds, 0 or more.");
    let baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
    let botId = options.botId;
    if (baseUrl && !/^https?:\/\/[^/?#\s]/i.test(baseUrl)) throw new MausBotError("`base_url` must be an http or https address.");
    if (!baseUrl || !botId) {
      const endpoint = (options.endpoint ?? env("MAUSBOT_BOT_URL"))?.trim();
      let match: RegExpMatchArray | null = null;
      let origin = "";
      try {
        const url = new URL(endpoint ?? "");
        origin = url.origin;
        match = url.pathname.match(/^(.*)\/hooks\/api\/(?:v1\/)?bots\/([^/]+)\/messages\/?$/);
      } catch { /* falls through to the refusal below */ }
      if (!match) throw new MausBotError(NO_ADDRESS);
      baseUrl = origin + match[1];
      try {
        botId = decodeURIComponent(match[2]);
      } catch {
        throw new MausBotError(NO_ADDRESS);
      }
    }
    if (!/^[\w-]{1,128}$/.test(botId)) throw new MausBotError(NO_ADDRESS);
    this.#path = `/hooks/api/v1/bots/${encodeURIComponent(botId)}/messages`;
    this.#http = { baseUrl, key, maxRetries, retryDelay, fetch: options.fetch ?? globalThis.fetch.bind(globalThis) };
  }

  async send(message: string, options: SendOptions = {}): Promise<ThreadState> {
    const body: Record<string, unknown> = { message };
    if (options.thread !== undefined) body.thread = options.thread;
    if (options.wait !== undefined) body.wait = options.wait;
    return normalise((await request(this.#http, { method: "POST", path: this.#path, body })).body);
  }

  async thread(id: string): Promise<ThreadState> {
    return this.#read(id);
  }

  async #read(id: string, signal?: AbortSignal): Promise<ThreadState> {
    return normalise((await request(this.#http, { method: "GET", path: this.#path, query: { thread: id }, signal })).body);
  }

  async wait(id: string, options: WaitOptions = {}): Promise<Answer> {
    const expire = () => new WaitTimeoutError("Still working when the wait ran out. Call wait again with this thread.", id);
    return this.#waitUntil(id, Date.now() + (options.timeout ?? 600) * 1000, options.pollInterval ?? 2, expire);
  }

  /** Reads the thread until it isn't working; `deadline` (ms) bounds the polls and each single read. */
  async #waitUntil(id: string, deadline: number, pollInterval: number, expire: () => Error): Promise<Answer> {
    let interval = pollInterval;
    for (;;) {
      const signal = AbortSignal.timeout(Math.max(deadline - Date.now(), 1));
      let state: ThreadState;
      try {
        state = await this.#read(id, signal);
      } catch (error) {
        throw signal.aborted ? expire() : error;
      }
      if (state.status === "failed") throw new JobFailedError(state.error, id);
      if (state.status !== "working") return state;
      const left = deadline - Date.now();
      if (left <= 0) throw expire();
      await sleep(Math.min(interval, left / 1000));
      interval = Math.min(interval * 1.5, 10);
    }
  }

  async ask(message: string, options: SendOptions & WaitOptions = {}): Promise<Answer> {
    const { timeout, pollInterval = 2, ...sendOptions } = options;
    const deadline = Date.now() + (timeout ?? 600) * 1000;
    let state: ThreadState;
    try {
      state = await this.send(message, sendOptions);
    } catch (error) {
      const busy = error instanceof ConflictError ? (error.body as { thread?: unknown; status?: unknown; error?: unknown } | undefined) : undefined;
      if (!busy || busy.status !== "working" || busy.error !== undefined || typeof busy.thread !== "string") throw error;
      const thread = busy.thread;
      const stillBusy = () => new NotSentError("The message was not sent: the thread was still busy when the wait ran out.", thread);
      try {
        const earlier = await this.#waitUntil(thread, deadline, pollInterval, stillBusy);
        if (earlier.status === "needs_approval") {
          throw new NotSentError("The message was not sent: the thread is waiting for an approval in the app.", thread);
        }
      } catch (earlierError) {
        // An earlier turn that failed leaves the thread free.
        if (!(earlierError instanceof JobFailedError)) throw earlierError;
      }
      state = await this.send(message, sendOptions);
    }
    if (state.status === "failed") throw new JobFailedError(state.error, state.thread);
    if (state.status !== "working") return state;
    return this.#waitUntil(state.thread, deadline, pollInterval, () => new WaitTimeoutError("Still working when the wait ran out. Call wait again with this thread.", state.thread));
  }
}
