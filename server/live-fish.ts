// Fish Audio Live 3 calls. The Fish key never leaves the harness: the client gets only Fish's single-use session token,
// and Fish has no server sideband, so the client relays what was said and the harness answers through FishRelay.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { LiveFishRelayCommand, LiveFishRelayEvent, LiveFishSessionToken } from "../shared/wire.ts";
import type { LiveSocket } from "./live-call-controller.ts";
import { liveInstructions, LiveSessionError, type LiveBot, type LiveEndpoint, type LiveHistoryMessage } from "./live-call.ts";

const FISH_BASE = "https://api.fish.audio";
const CREATE_TIMEOUT_MS = 20_000;
const END_TIMEOUT_MS = 5_000;
/** Fish agent ids as the dashboard and `GET /v1/agent/agents` show them. */
const AGENT_ID = /^[\w-]{1,128}$/;
const HISTORY_MESSAGES = 8;
const HISTORY_MESSAGE_CHARS = 600;
const HISTORY_TOTAL_CHARS = 6_000;
export const FISH_DELEGATE_TOOL = "delegate";
/** What a "fish" call reports as its voice: the voice is set on the Fish agent, not per call. */
export const FISH_AGENT_VOICE = "agent";
export const FISH_UPDATE_PREFIX = "[OpenMausBot]";
const MAX_QUEUED_COMMANDS = 50;
export const RELAY_POLL_MS = 15_000;

/** Only a loopback http URL is accepted, read at call time. */
export function fishLiveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_FISH_LIVE_URL?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : FISH_BASE;
}

/** null without a usable agent id. */
export function fishLiveEndpoint(agentId: string | undefined, env: NodeJS.ProcessEnv = process.env): LiveEndpoint | null {
  const id = agentId?.trim() ?? "";
  return AGENT_ID.test(id) ? { provider: "fish", apiBase: `${fishLiveBaseUrl(env)}/v1/agent`, model: id } : null;
}

export function isFishAgentId(value: string): boolean {
  return AGENT_ID.test(value);
}

/** The Fish agent's system prompt for this call: the GPT-Live instructions, how this agent delegates, and the recent chat. */
export function fishInstructions(bot: LiveBot, history: LiveHistoryMessage[], { cloudHome = false }: { cloudHome?: boolean } = {}): string {
  const lines = [
    liveInstructions(bot, { cloudHome }),
    "",
    `To delegate, call the \`${FISH_DELEGATE_TOOL}\` tool with the user's request in their own words. Its result is what you learned or did; speak it naturally and briefly.`,
    `A user message that starts with ${FISH_UPDATE_PREFIX} is not the user speaking: it is a later result or a status note from your work. Speak it to the user naturally, in the first person, without reading the prefix.`,
    "Do not end the call yourself. When the user asks to hang up, delegate it.",
  ];
  const recent = recentHistory(history);
  if (recent.length) {
    lines.push("", "The conversation so far, most recent last:");
    for (const message of recent) lines.push(`${message.role === "user" ? "User" : "You"}: ${message.text}`);
  }
  return lines.join("\n");
}

function recentHistory(history: LiveHistoryMessage[]): LiveHistoryMessage[] {
  const picked: LiveHistoryMessage[] = [];
  let total = 0;
  for (const message of [...history].reverse()) {
    if (picked.length >= HISTORY_MESSAGES) break;
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, HISTORY_MESSAGE_CHARS);
    if (!text) continue;
    if (total + text.length > HISTORY_TOTAL_CHARS) break;
    total += text.length;
    picked.unshift({ role: message.role, text });
  }
  return picked;
}

export interface CreateFishSessionInput {
  key: string;
  endpoint: LiveEndpoint;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  cloudHome: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fish API v1 `POST /v1/agent/sessions`. Errors carry a status and a message fit for the user: never the key, never Fish's raw body. */
export async function createFishLiveSession(input: CreateFishSessionInput): Promise<LiveFishSessionToken> {
  const key = input.key.trim();
  if (!key) throw new LiveSessionError("Add a Fish Audio API key to use Live calls.", 409);
  const body = {
    agent_id: input.endpoint.model,
    // Fish refuses an override the agent's `overrides_allowed` does not list (400).
    overrides: { system_prompt: fishInstructions(input.bot, input.history, { cloudHome: input.cloudHome }) },
  };
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${input.endpoint.apiBase}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LiveSessionError(timedOut ? "Fish Audio did not answer in time. Try the call again." : "Could not reach Fish Audio. Check the internet connection.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LiveSessionError(fishErrorMessage(response.status), response.status === 429 ? 429 : 502);
  }
  const token = await response.json().catch(() => null) as Partial<LiveFishSessionToken> | null;
  if (!token || token.transport !== "livekit" || typeof token.session_id !== "string" || !token.session_id
    || typeof token.token !== "string" || !token.token || typeof token.livekit_url !== "string" || !/^(wss|https):\/\//.test(token.livekit_url)) {
    throw new LiveSessionError("Fish Audio returned an unexpected answer. Try the call again.", 502);
  }
  return {
    transport: "livekit",
    session_id: token.session_id,
    expires_at: typeof token.expires_at === "string" ? token.expires_at : "",
    max_duration_seconds: Number(token.max_duration_seconds) || 0,
    livekit_url: token.livekit_url,
    token: token.token,
  };
}

/** Fish API v1 `POST /v1/agent/sessions/{id}/end`; best effort, never throws. */
export async function endFishLiveSession(sessionId: string, key: string, endpoint: LiveEndpoint, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${endpoint.apiBase}/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.trim()}` },
      redirect: "error",
      signal: AbortSignal.timeout(END_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export function fishErrorMessage(status: number): string {
  switch (status) {
    case 400: return "Fish Audio rejected the call settings. In the agent's settings, allow the system prompt override.";
    case 401: return "Fish Audio rejected the API key. Check the key for Live calls.";
    case 402: return "The Fish Audio account has no credit for agent calls.";
    case 403: return "This Fish Audio key may not start that agent.";
    case 404: return "Fish Audio has no agent with that id. Check the agent id in Call settings.";
    case 409: return "The Fish Audio agent has not been published. Publish it in Fish Audio, then call again.";
    case 422: return "Fish Audio could not use the call request (HTTP 422).";
    case 429: return "Fish Audio is limiting agent sessions right now. Try again in a moment.";
    default: return status >= 500 ? "Fish Audio had a problem starting the call. Try again in a moment." : `Fish Audio could not start the call (HTTP ${status}).`;
  }
}

const SOCKET = { connecting: 0, open: 1, closed: 3 } as const;
/** What the client of a fish call says it heard ends a call this way; anything else is the call's own ending. */
const CLIENT_END_REASONS: Record<string, string> = {
  agent_hangup: "remote_hangup",
  conversation_timeout: "expired",
  connection_lost: "connection_lost",
};

/** The controller's sideband for a "fish" call. The client's reports arrive through `receive` and are read exactly as
 * GPT-Live's sideband events are; the controller's commands queue for the client's `poll`. Everything the client sends is
 * the caller's own claim, so a fish call is held only by someone fishLiveCallRefusal admits (live-access.ts). */
export class FishRelay implements LiveSocket {
  readyState: number = SOCKET.connecting;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sessionId: string;
  private readonly token: Buffer;
  private readonly endSession: () => Promise<unknown>;
  private readonly forget: () => void;
  private queue: LiveFishRelayCommand[] = [];
  private waiter: (() => void) | null = null;
  private ended: Promise<unknown> | null = null;

  constructor(input: { sessionId: string; token: string; endSession: () => Promise<unknown>; forget: () => void }) {
    this.sessionId = input.sessionId;
    this.token = Buffer.from(input.token);
    this.endSession = input.endSession;
    this.forget = input.forget;
  }

  holds(token: string): boolean {
    const offered = Buffer.from(token);
    return offered.length === this.token.length && timingSafeEqual(offered, this.token);
  }

  send(data: string): void {
    if (this.readyState === SOCKET.closed) throw new Error("relay closed");
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = /^session\.(instructions|thinking|commentary)\.append$/.exec(String(event.type))?.[1] as "instructions" | "thinking" | "commentary" | undefined;
    if (kind) {
      if (typeof event.content !== "string" || !event.content) return;
      this.push({ type: "append", kind, content: event.content, delegationId: typeof event.delegation_id === "string" ? event.delegation_id : null });
      return;
    }
    if (event.type === "session.close") {
      this.push({ type: "close" });
      void this.end().then(() => this.deliver({ type: "session.closed" }));
    }
  }

  close(): void {
    if (this.readyState === SOCKET.closed) return;
    this.readyState = SOCKET.closed;
    this.queue.push({ type: "close" });
    this.wake();
    this.forget();
    void this.end();
  }

  /** The client's reports, in order. Before the client has joined only `connected`, `ended` and `error` count. */
  receive(events: LiveFishRelayEvent[]): void {
    for (const event of events) {
      if (this.readyState === SOCKET.closed) return;
      if (event.type === "connected") {
        if (this.readyState !== SOCKET.connecting) continue;
        this.readyState = SOCKET.open;
        this.onopen?.({});
        continue;
      }
      if (event.type === "ended") {
        this.deliver({ type: "session.closed", ...(CLIENT_END_REASONS[event.reason] ? { reason: CLIENT_END_REASONS[event.reason] } : {}) });
        continue;
      }
      if (event.type === "error") {
        this.deliver({ type: "error", error: { code: event.code } });
        continue;
      }
      if (this.readyState !== SOCKET.open) continue;
      if (event.type === "heard") {
        // GPT-Live's deltas are fragments glued as sent; a whole Fish utterance needs its own space.
        this.deliver({ type: "session.input_transcript.delta", delta: `${event.text} `, start_ms: event.startMs, end_ms: event.endMs });
      } else if (event.type === "spoke") {
        this.deliver({ type: "session.output_transcript.delta", start_ms: event.startMs, end_ms: event.endMs });
      } else if (event.type === "delegate") {
        this.deliver({ type: "session.delegation.created", delegation: { id: event.id, target: "client" }, offset_ms: event.atMs });
      }
    }
  }

  /** The queued commands, waiting up to `waitMs` for one. A newer poll answers an older one with nothing. */
  async poll(waitMs: number): Promise<{ commands: LiveFishRelayCommand[]; closed: boolean }> {
    if (!this.queue.length && this.readyState !== SOCKET.closed && waitMs > 0) {
      this.wake();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (this.waiter === done) this.waiter = null;
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        timer.unref?.();
        this.waiter = done;
      });
    }
    const commands = this.queue.splice(0);
    return { commands, closed: this.readyState === SOCKET.closed };
  }

  private push(command: LiveFishRelayCommand): void {
    this.queue.push(command);
    if (this.queue.length > MAX_QUEUED_COMMANDS) this.queue.splice(0, this.queue.length - MAX_QUEUED_COMMANDS);
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private deliver(event: Record<string, unknown>): void {
    if (this.readyState === SOCKET.closed) return;
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  private end(): Promise<unknown> {
    this.ended ??= this.endSession().catch(() => undefined);
    return this.ended;
  }
}

/** The relays of running fish calls, by Fish session id. */
export class FishRelays {
  private readonly relays = new Map<string, FishRelay>();

  /** A relay for a session just created; its token goes only to the client that started the call. */
  open(sessionId: string, endSession: () => Promise<unknown>): { relay: FishRelay; token: string } {
    const token = randomBytes(32).toString("base64url");
    this.relays.get(sessionId)?.close();
    const relay = new FishRelay({ sessionId, token, endSession, forget: () => {
      if (this.relays.get(sessionId) === relay) this.relays.delete(sessionId);
    } });
    this.relays.set(sessionId, relay);
    return { relay, token };
  }

  /** The controller's attach: the relay `open` made for this session. */
  socket(sessionId: string): FishRelay {
    const relay = this.relays.get(sessionId);
    if (!relay) throw new Error("no relay for that session");
    return relay;
  }

  /** null unless the token is this session's. */
  find(sessionId: string, token: string): FishRelay | null {
    const relay = this.relays.get(sessionId);
    return relay?.holds(token) ? relay : null;
  }
}
