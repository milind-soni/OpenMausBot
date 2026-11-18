import { ConflictError, JobFailedError, MausBotError, NotSentError, WaitTimeoutError } from "./errors.js";
import { request, type HttpConfig } from "./http.js";

export type Answer = { status: "replied"; reply: string; thread: string } | { status: "needs_approval"; thread: string };
export type ThreadState = Answer | { status: "working"; thread: string } | { status: "failed"; thread: string; error: string };
export interface BotOptions { endpoint?: string; baseUrl?: string; botId?: string; key?: string; maxRetries?: number; retryDelay?: number; fetch?: typeof fetch }
/** Seconds. */
export interface WaitOptions { timeout?: number; pollInterval?: number }
type SendOptions = { thread?: string; wait?: number };

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
  private readonly http: HttpConfig;
  private readonly path: string;

  constructor(options: BotOptions = {}) {
    const key = (options.key ?? env("MAUSBOT_BOT_KEY"))?.trim();
    if (!key) throw new MausBotError("No key: pass `key` or set MAUSBOT_BOT_KEY.");
    let baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
    let botId = options.botId;
    if (!baseUrl || !botId) {
      const endpoint = (options.endpoint ?? env("MAUSBOT_BOT_URL"))?.trim();
      let match: RegExpMatchArray | null = null;
      let origin = "";
      try {
        const url = new URL(endpoint ?? "");
        origin = url.origin;
        match = url.pathname.match(/^(.*)\/hooks\/api\/(?:v1\/)?bots\/([^/]+)\/messages\/?$/);
      } catch { /* falls through to the refusal below */ }
      if (!match) throw new MausBotError("No bot address: pass `endpoint` (the address on the bot's Bot API card) or set MAUSBOT_BOT_URL.");
      baseUrl = origin + match[1];
      botId = decodeURIComponent(match[2]);
    }
    this.path = `/hooks/api/v1/bots/${encodeURIComponent(botId)}/messages`;
    this.http = { baseUrl, key, maxRetries: options.maxRetries ?? 2, retryDelay: options.retryDelay ?? 0.5, fetch: options.fetch ?? globalThis.fetch.bind(globalThis) };
  }

  async send(message: string, options: SendOptions = {}): Promise<ThreadState> {
    const body: Record<string, unknown> = { message };
    if (options.thread !== undefined) body.thread = options.thread;
    if (options.wait !== undefined) body.wait = options.wait;
    return normalise((await request(this.http, { method: "POST", path: this.path, body })).body);
  }

  async thread(id: string): Promise<ThreadState> {
    return normalise((await request(this.http, { method: "GET", path: this.path, query: { thread: id } })).body);
  }

  async wait(id: string, options: WaitOptions = {}): Promise<Answer> {
    const deadline = Date.now() + (options.timeout ?? 600) * 1000;
    let interval = options.pollInterval ?? 2;
    for (;;) {
      const state = await this.thread(id);
      if (state.status === "failed") throw new JobFailedError(state.error, id);
      if (state.status !== "working") return state;
      if (Date.now() >= deadline) throw new WaitTimeoutError("Still working when the wait ran out. Call wait again with this thread.", id);
      await sleep(interval);
      interval = Math.min(interval * 1.5, 10);
    }
  }

  async ask(message: string, options: SendOptions & WaitOptions = {}): Promise<Answer> {
    const { timeout, pollInterval, ...sendOptions } = options;
    const waitOptions = { timeout, pollInterval };
    let state: ThreadState;
    try {
      state = await this.send(message, sendOptions);
    } catch (error) {
      const busy = error instanceof ConflictError ? (error.body as { thread?: unknown; status?: unknown; error?: unknown } | undefined) : undefined;
      if (!busy || busy.status !== "working" || busy.error !== undefined || typeof busy.thread !== "string") throw error;
      const earlier = await this.wait(busy.thread, waitOptions);
      if (earlier.status === "needs_approval") {
        throw new NotSentError("The message was not sent: the thread is waiting for an approval in the app.", busy.thread);
      }
      state = await this.send(message, sendOptions);
    }
    if (state.status === "failed") throw new JobFailedError(state.error, state.thread);
    return state.status === "working" ? this.wait(state.thread, waitOptions) : state;
  }
}
