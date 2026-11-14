// A Fish Audio call: Fish's SDK holds the microphone and the agent's audio; the harness hears the call only through what
// this relays to POST /api/live/relay, and the bot's replies come back the same way.
import type { LiveFishRelayCommand, LiveFishRelayEvent, LiveFishSessionToken, LiveFishTransport } from "../../shared/wire";

/** The client tool the Fish agent calls to delegate; set up on the agent as a client tool with `expects_response`. */
export const FISH_DELEGATE_TOOL = "delegate";
export const FISH_UPDATE_PREFIX = "[OpenMausBot]";
/** How long a delegate call waits for the harness's first word on it; later words arrive as updates. */
export const DELEGATE_ANSWER_MS = 8_000;
const CLIENT_TOOL_TIMEOUT_MS = 12_000;
const MAX_EVENTS_PER_POST = 20;
const MAX_TEXT = 2_000;
const RETRY_MS = 1_000;
const MAX_POLL_FAILURES = 5;

/** The part of `@fishaudio/agent-client` 1.x `AgentSession` a call uses. */
export interface FishAgentSession {
  sendUserMessage(text: string, options?: { audio?: boolean }): void;
  setMicMuted(muted: boolean): Promise<void>;
  end(): Promise<void>;
}

export interface FishSessionOptions {
  sessionToken: LiveFishSessionToken;
  clientTools: Record<string, (params: Record<string, unknown>, context: { callId: string }) => Promise<unknown>>;
  clientToolTimeoutMs: number;
  callbacks: {
    onConnect(event: { sessionId: string }): void;
    onDisconnect(event: { reason: string }): void;
    onModeChange(mode: string): void;
    onUserTranscript(event: { segmentId: string; text: string; final: boolean }): void;
    onAgentResponseDelta(event: { segmentId: string; text: string }): void;
    onError(error: { code?: string }): void;
  };
}

export type FishSessionStarter = (options: FishSessionOptions) => Promise<FishAgentSession>;

/** Loaded on the first Fish call only. */
export const startFishAgentSession: FishSessionStarter = async (options) => {
  const { AgentSession } = await import("@fishaudio/agent-client");
  return AgentSession.start(options);
};

export function isFishMicDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "mic_permission_denied";
}

export interface FishCallHooks {
  request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T>;
  connected(): void;
  /** What the person is saying, for the caption. */
  heard(text: string): void;
  /** What the agent is saying, for the caption. */
  said(text: string): void;
  /** Fish ended the session. */
  ended(reason: string): void;
  now(): number;
}

type RelayAnswer = { commands: LiveFishRelayCommand[]; closed: boolean };

export class FishCall {
  private readonly transport: LiveFishTransport;
  private readonly hooks: FishCallHooks;
  private readonly starter: FishSessionStarter;
  private readonly startedAt: number;
  private session: FishAgentSession | null = null;
  private closed = false;
  private outbox: LiveFishRelayEvent[] = [];
  /** How many events the relay has taken; a retried batch carries its first one's number, so none is applied twice. */
  private delivered = 0;
  private flushing: Promise<void> | null = null;
  private readonly segmentStarts = new Map<string, number>();
  private speakingSince: number | null = null;
  private readonly waiting = new Map<string, (content: string | null) => void>();

  constructor(transport: LiveFishTransport, hooks: FishCallHooks, starter: FishSessionStarter = startFishAgentSession) {
    this.transport = transport;
    this.hooks = hooks;
    this.starter = starter;
    this.startedAt = hooks.now();
  }

  /** Joins the session; rejects as Fish's SDK does, e.g. with code `mic_permission_denied`. */
  async start(): Promise<void> {
    const session = await this.starter({
      sessionToken: this.transport.session,
      clientTools: { [FISH_DELEGATE_TOOL]: (_params, context) => this.delegate(context.callId) },
      clientToolTimeoutMs: CLIENT_TOOL_TIMEOUT_MS,
      callbacks: {
        onConnect: () => {
          this.relay({ type: "connected" });
          this.hooks.connected();
        },
        onDisconnect: ({ reason }) => {
          if (this.closed) return;
          this.relay({ type: "ended", reason: /^[a-z_]{0,40}$/.test(reason) ? reason : "" });
          this.hooks.ended(reason);
        },
        onModeChange: (mode) => this.onMode(mode),
        onUserTranscript: (event) => this.onTranscript(event),
        onAgentResponseDelta: (event) => this.hooks.said(event.text),
        onError: (error) => this.relay({ type: "error", code: /^[\w.-]{1,40}$/.test(error.code ?? "") ? error.code! : "error" }),
      },
    });
    if (this.closed) {
      void session.end().catch(() => undefined);
      return;
    }
    this.session = session;
    void this.pollLoop();
  }

  setMuted(muted: boolean): void {
    void this.session?.setMicMuted(muted).catch(() => undefined);
  }

  /** Ends the Fish session and stops relaying. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    const session = this.session;
    this.session = null;
    void session?.end().catch(() => undefined);
  }

  private now(): number {
    return Math.max(0, this.hooks.now() - this.startedAt);
  }

  private onTranscript(event: { segmentId: string; text: string; final: boolean }): void {
    if (!this.segmentStarts.has(event.segmentId)) this.segmentStarts.set(event.segmentId, this.now());
    this.hooks.heard(event.text);
    if (!event.final) return;
    const startMs = this.segmentStarts.get(event.segmentId)!;
    this.segmentStarts.delete(event.segmentId);
    const text = event.text.trim().slice(0, MAX_TEXT);
    if (text) this.relay({ type: "heard", text, startMs, endMs: Math.max(startMs, this.now()) });
  }

  private onMode(mode: string): void {
    if (mode === "speaking") {
      this.speakingSince ??= this.now();
      return;
    }
    if (this.speakingSince === null) return;
    this.relay({ type: "spoke", startMs: this.speakingSince, endMs: this.now() });
    this.speakingSince = null;
  }

  /** The harness reads the request from what it heard, never from the agent's arguments. */
  private delegate(callId: string): Promise<unknown> {
    const id = callId.replace(/[^\w.:-]/g, "").slice(0, 120) || `d${this.hooks.now()}`;
    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.get(id) === done) this.waiting.delete(id);
        resolve(null);
      }, DELEGATE_ANSWER_MS);
      const done = (content: string | null) => {
        clearTimeout(timer);
        resolve(content);
      };
      this.waiting.set(id, done);
    });
    this.relay({ type: "delegate", id, atMs: this.now() });
    return answer.then((content) => content ?? "I am working on it; the result will follow as an update.");
  }

  private relay(event: LiveFishRelayEvent): void {
    if (this.closed) return;
    this.outbox.push(event);
    this.flushing ??= this.flush().finally(() => {
      this.flushing = null;
    });
  }

  private async flush(): Promise<void> {
    await Promise.resolve();
    while (this.outbox.length && !this.closed) {
      const events = this.outbox.slice(0, MAX_EVENTS_PER_POST);
      try {
        const answer = await this.post({ events, from: this.delivered });
        this.delivered += events.length;
        this.outbox.splice(0, events.length);
        this.apply(answer);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      try {
        const answer = await this.post({ wait: true });
        failures = 0;
        this.apply(answer);
        if (answer.closed) return;
      } catch {
        // Unreachable, the harness can neither answer nor end the call, so it is not left running on Fish.
        if (++failures >= MAX_POLL_FAILURES) {
          this.close();
          this.hooks.ended("relay_unavailable");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS * failures));
      }
    }
  }

  private post(body: { events?: LiveFishRelayEvent[]; from?: number; wait?: boolean }): Promise<RelayAnswer> {
    return this.hooks.request<RelayAnswer>("/api/live/relay", {
      method: "POST",
      body: JSON.stringify({ sessionId: this.transport.session.session_id, token: this.transport.relayToken, ...body }),
      timeoutMs: 25_000,
    });
  }

  private apply(answer: RelayAnswer): void {
    for (const command of answer.commands ?? []) {
      if (this.closed) return;
      if (command.type === "close") {
        this.close();
        return;
      }
      const waiter = command.delegationId ? this.waiting.get(command.delegationId) : undefined;
      if (waiter) {
        this.waiting.delete(command.delegationId!);
        waiter(command.content);
        continue;
      }
      // A status note is for the agent to know, not to read out.
      this.session?.sendUserMessage(`${FISH_UPDATE_PREFIX} ${command.content}`, { audio: command.kind !== "thinking" });
    }
  }
}
