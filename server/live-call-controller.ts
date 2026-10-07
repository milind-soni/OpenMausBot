// The harness side of a Live call (spec: docs/superpowers/specs/2026-09-25-live-call-bar-design.md).
//
// A client (desktop renderer, iPhone or Android app) holds the microphone
// and speaker over WebRTC, straight to OpenAI. This controller holds the
// sideband WebSocket to the same GPT-Live session and runs every rule that
// connects the voice to the bot, so all three clients behave the same:
//   delegation → a user message "via call", carrying the call's id, on the bot's thread;
//   bot progress → quiet thinking; the turn's final text → spoken commentary;
//   an approval card → a strict spoken yes/no; a question card → the next request;
//   a typed message → nothing until the bot answers it; then the answer is read
//   with what was typed (readTypedReplies on), or nothing about it at all
//   reaches OpenAI (off);
//   no speech and no work for idleMinutes → hang up.
// Nothing said on the call is logged; the summary line has counters only.
import { randomUUID } from "node:crypto";
import { spokenConsent } from "../shared/call-consent.ts";
import {
  LIVE_COPY, liveCardKind, liveStepLabel, spokenApprovalPrompt, spokenConnectorPrompt, spokenQuestionPrompt, spokenReviewPrompt, spokenSecretPrompt,
} from "../shared/live-approval.ts";
import { clampAppend, commentaryChunks, LiveTranscript } from "../shared/live-call.ts";
import type { LiveCallRecord, LiveCallState, LiveClient, LiveEndReason } from "../shared/wire.ts";
import { liveCallSummaryLine, LiveSessionError, liveVoice } from "./live-call.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { Message, StoreChange } from "./store.ts";

export const DELEGATION_SETTLE_MS = 700;
export const CONSENT_SETTLE_MS = 1_200;
export const PROGRESS_INTERVAL_MS = 4_000;
export const ATTACH_TIMEOUT_MS = 10_000;
export const CLOSE_TIMEOUT_MS = 5_000;
export const IDLE_CHECK_MS = 15_000;
/** How often the voice gets a quiet status note while the bot works. */
export const STATUS_INTERVAL_MS = 30_000;
const SOCKET_OPEN = 1;
const MAX_ERRORS = 5;
/** Unpaired phones remembered, so a start already in flight when its phone
 * was unpaired is refused too. Ids are never reused: a new pairing gets a new one. */
const MAX_REVOKED_DEVICES = 200;
/** How far past a spoken decision GPT-Live's own delegation of the same
 * yes/no may land on the session timeline (takeRequest allows 1.5 s of
 * trailing transcript; the delegation point trails the words a little). */
const DECISION_ECHO_MS = 3_000;

export interface LiveSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LiveActivity = "idle" | "working" | "waiting";
export type LiveSendResult = { kind: "started" | "steered"; messageId: string } | { kind: "queued"; queueId: string };
export type LiveRespondResult = { ok: true } | { ok: false; error: string };

export interface LiveCallDeps {
  store: { onChange(listener: (change: StoreChange) => void): () => void };
  /** Throws LiveCallSignedOutError once the sign-in that started the call has ended.
   * `callId`: the call the words were spoken on; the harness stores it on the line. */
  send(input: { auth: RequestAuth; botId: string; threadId: string; text: string; callId: string }): Promise<LiveSendResult>;
  /** Throws LiveCallSignedOutError once the sign-in that started the call has ended.
   * `callId` comes with a spoken answer to a question: an answer that arrives
   * after its turn ended is stored as one of the call's lines. */
  respond(input: { auth: RequestAuth; threadId: string; requestId: string; behavior: "allow" | "deny" | "answer"; message?: string; callId?: string }): Promise<LiveRespondResult>;
  /** Whether a call request that send() queued still waits in the thread's
   * queue. Editing or cancelling it in a client removes it undelivered. */
  queued(botId: string, threadId: string, queueId: string): boolean;
  /** Whether the sign-in that started a call is still valid (checked with the idle timer). Omitted: always. */
  signedIn?(auth: RequestAuth): boolean;
  /** Who a message from `auth` names as its sender (`message.sender.id`):
   * undefined for the owner on this computer, whose lines carry no sender. */
  personKey?(auth: RequestAuth): string | undefined;
  activity(botId: string, threadId: string): LiveActivity;
  broadcast(frame: { kind: "live.call"; botId: string; threadId: string; call: LiveCallState | null }): void;
  settings(): { key: string; voice: string; readTypedReplies: boolean; idleMinutes: number };
  createSession(input: { key: string; sdp: string; botId: string; threadId: string; voice: string }): Promise<{ sessionId: string; sdp: string }>;
  openSocket(url: string, key: string): LiveSocket;
  attachUrl(sessionId: string): string;
  speakable(text: string): string[];
  /** A call that went live has ended: write its one "call" row on the
   * call's chat. Called once per such call, never for a call that did not
   * attach. Omitted: no row. */
  recordCall?(input: { threadId: string; botName: string; record: LiveCallRecord }): void;
  log(line: string): void;
  now?(): number;
}

export class LiveCallBusyError extends Error {
  readonly call: LiveCallState;
  constructor(call: LiveCallState) {
    super("A Live call is already running.");
    this.call = call;
  }
}

/** The person who started the call signed out, or their session was
 * revoked: the call must not keep reaching the bot on their behalf. */
export class LiveCallSignedOutError extends LiveSessionError {
  constructor() {
    super("The sign-in that started this call has ended.", 401);
  }
}

type AppendKind = "instructions" | "thinking" | "commentary";
type Timer = ReturnType<typeof setTimeout>;

interface OpenCard {
  requestId: string;
  messageId: string;
  submitted: boolean;
}

interface Call {
  state: LiveCallState;
  auth: RequestAuth;
  /** The paired phone that started the call, as the companion vouched for it
   * (null for the computer's own window or a signed-in browser). A phone's
   * requests arrive as loopback, so this is what its unpairing ends. */
  device: string | null;
  /** the sender id the caller's own typed lines carry (undefined: the owner) */
  personKey: string | undefined;
  botName: string;
  key: string;
  sessionId: string;
  socket: LiveSocket | null;
  attached: boolean;
  transcript: LiveTranscript;
  /** end of the latest input transcript fragment, on the session timeline */
  heardThroughMs: number;
  /** the last spoken approval decision: where its words ended, what was said back */
  lastDecision: { throughMs: number; copy: string } | null;
  eventCounter: number;
  activeDelegation: string | null;
  lastProgressAt: number;
  lastActivityAt: number;
  lastActivity: LiveActivity;
  /** the current piece of bot work, for the voice's status notes (null while idle) */
  workStartedAt: number | null;
  workSteps: number;
  lastStep: string | null;
  lastStepAt: number;
  lastStatusAt: number;
  approval: OpenCard | null;
  question: OpenCard | null;
  /** cards that opened while another one was open, oldest first */
  waitingCards: Message[];
  announced: Set<string>;
  /** call requests (user message ids) still waiting for an answer */
  pendingCall: Set<string>;
  /** a call request was steered into a running turn: its next answer is ours */
  claimNextTerminal: boolean;
  /** call requests waiting in the thread's queue (queue ids), until delivered or removed */
  queuedIds: Set<string>;
  /** typed user messages on the thread (id → text), until their answer arrives */
  typedTexts: Map<string, string>;
  /** Lines a drain delivered together, as one turn answering the last of
   * them: each drained line → its batch. `drainBatch` is the batch still
   * being appended (drained lines arrive back to back). */
  batches: Map<string, string[]>;
  drainBatch: string[] | null;
  spokenAnswers: Set<string>;
  pendingEnd: LiveEndReason | null;
  timers: Set<Timer>;
  consentTimer: Timer | null;
  idleTimer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
  closeWaiters: Array<() => void>;
  stats: { delegations: number; sentToBot: number; answers: number; approvals: number; notHeard: number; replies: number; seconds: number | null; errors: string[] };
}

const CLOSE_REASONS: Record<string, LiveEndReason> = {
  expired: "expired",
  content: "content",
  remote_hangup: "remote-hangup",
  connection_lost: "connection-lost",
};

export class LiveCallController {
  private readonly deps: LiveCallDeps;
  private call: Call | null = null;
  private readonly revokedDevices = new Set<string>();

  constructor(deps: LiveCallDeps) {
    this.deps = deps;
  }

  current(): LiveCallState | null {
    return this.call && this.call.state.status !== "ended" ? { ...this.call.state } : null;
  }

  /** `device`: the paired phone the companion vouched for, when the request came through it. */
  async start(input: { auth: RequestAuth; device?: string; botId: string; botName: string; threadId: string; client: LiveClient; sdp: string }): Promise<{ call: LiveCallState; sdp: string }> {
    if (this.call && this.call.state.status !== "ended") throw new LiveCallBusyError({ ...this.call.state });
    if (input.device && this.revokedDevices.has(input.device)) throw new LiveCallSignedOutError();
    const settings = this.deps.settings();
    const key = settings.key.trim();
    if (!key) throw new LiveSessionError("Add an OpenAI API key to use Live calls.", 409);
    const voice = liveVoice(settings.voice);
    const call = this.newCall(input, key, voice);
    // Taken before the first await: a second start in the same tick is refused.
    this.call = call;
    let session: { sessionId: string; sdp: string };
    try {
      session = await this.deps.createSession({ key, sdp: input.sdp, botId: input.botId, threadId: input.threadId, voice });
    } catch (error) {
      if (this.call === call) this.call = null;
      this.deps.log(`[live] call failed bot=${input.botId} client=${input.client} status=${error instanceof LiveSessionError ? error.status : "error"}`);
      throw error;
    }
    if (this.call !== call) {
      this.closeOrphan(session.sessionId, key);
      throw new LiveSessionError("The call was cancelled.", 503);
    }
    try {
      call.sessionId = session.sessionId;
      call.state.startedAt = this.now();
      call.lastActivityAt = this.now();
      call.lastActivity = this.deps.activity(input.botId, input.threadId);
      if (call.lastActivity === "working") this.beginWork(call);
      call.unsubscribe = this.deps.store.onChange((change) => this.onStoreChange(call, change));
      this.deps.log(`[live] call started bot=${input.botId} voice=${voice} client=${input.client}`);
      this.emit(call);
      // Before attach: a sideband that fails at once finishes the call, and
      // finish must find the interval to clear it.
      call.idleTimer = setInterval(() => this.guarded(call, () => this.checkIdle(call)), IDLE_CHECK_MS);
      call.idleTimer.unref?.();
      this.attach(call);
    } catch (error) {
      // Never leave the one call slot taken by a call that did not start.
      const sidebandOpened = call.socket !== null;
      this.finish(call, "error", "The call could not start.");
      // No sideband owns the session OpenAI made: close it, as a cancelled start does.
      if (!sidebandOpened) this.closeOrphan(session.sessionId, key);
      throw error;
    }
    return { call: { ...call.state }, sdp: session.sdp };
  }

  async end(callId: string): Promise<LiveCallState | null> {
    const call = this.call;
    if (!call || call.state.callId !== callId || call.state.status === "ended") return null;
    await this.hangUp(call, "hung-up");
    return { ...call.state };
  }

  async shutdown(): Promise<void> {
    const call = this.call;
    if (!call || call.state.status === "ended") return;
    this.command(call, { type: "session.close" });
    this.finish(call, "shutdown");
  }

  /** A paired phone was unpaired (the companion says so). Its call, if it
   * holds the line, ends at once; a start of its still in flight is refused.
   * Returns the call it ended, or null. */
  deviceRevoked(deviceId: string): LiveCallState | null {
    this.revokedDevices.add(deviceId);
    if (this.revokedDevices.size > MAX_REVOKED_DEVICES) this.revokedDevices.delete(this.revokedDevices.values().next().value!);
    const call = this.call;
    if (!call || call.device !== deviceId) return null;
    return this.endSignedOut(call, null, LIVE_COPY.unpaired) ? { ...call.state } : null;
  }

  /** A sign-in was revoked or signed out. The idle check would notice within
   * IDLE_CHECK_MS; this ends the call it started at once. */
  sessionRevoked(sessionId: string): LiveCallState | null {
    const call = this.call;
    if (!call || call.auth.kind !== "session" || call.auth.session.id !== sessionId) return null;
    return this.endSignedOut(call, null) ? { ...call.state } : null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  private newCall(input: { auth: RequestAuth; device?: string; botId: string; botName: string; threadId: string; client: LiveClient }, key: string, voice: string): Call {
    return {
      state: { callId: randomUUID(), botId: input.botId, threadId: input.threadId, client: input.client, voice, startedAt: this.now(), status: "connecting" },
      auth: input.auth,
      device: input.device ?? null,
      personKey: this.deps.personKey?.(input.auth),
      botName: input.botName,
      key,
      sessionId: "",
      socket: null,
      attached: false,
      transcript: new LiveTranscript(),
      heardThroughMs: 0,
      lastDecision: null,
      eventCounter: 0,
      activeDelegation: null,
      lastProgressAt: 0,
      lastActivityAt: this.now(),
      lastActivity: "idle",
      workStartedAt: null,
      workSteps: 0,
      lastStep: null,
      lastStepAt: 0,
      lastStatusAt: 0,
      approval: null,
      question: null,
      waitingCards: [],
      announced: new Set(),
      pendingCall: new Set(),
      claimNextTerminal: false,
      queuedIds: new Set(),
      typedTexts: new Map(),
      batches: new Map(),
      drainBatch: null,
      spokenAnswers: new Set(),
      pendingEnd: null,
      timers: new Set(),
      consentTimer: null,
      idleTimer: null,
      unsubscribe: null,
      closeWaiters: [],
      stats: { delegations: 0, sentToBot: 0, answers: 0, approvals: 0, notHeard: 0, replies: 0, seconds: null, errors: [] },
    };
  }

  private attach(call: Call): void {
    let socket: LiveSocket;
    try {
      socket = this.deps.openSocket(this.deps.attachUrl(call.sessionId), call.key);
    } catch {
      this.finish(call, "sideband-lost", "The call could not connect to OpenAI.");
      return;
    }
    call.socket = socket;
    const attachTimer = this.later(call, () => {
      if (!call.attached) this.finish(call, "sideband-lost", "The call could not connect to OpenAI.");
    }, ATTACH_TIMEOUT_MS);
    socket.onopen = () => {
      call.attached = true;
      this.clear(call, attachTimer);
      if (call.state.status === "connecting") {
        call.state.status = "live";
        this.emit(call);
      }
    };
    socket.onmessage = (event) => this.guarded(call, () => this.onSideband(call, event.data));
    // Node's WebSocket reports a refused handshake as an error without a close.
    socket.onerror = () => {
      if (!call.attached) this.finish(call, "sideband-lost", "The call could not connect to OpenAI.");
    };
    socket.onclose = () => {
      if (call.state.status === "ended") return;
      if (call.pendingEnd) this.finish(call, call.pendingEnd);
      else this.finish(call, "sideband-lost", "The call connection to OpenAI dropped.");
    };
  }

  /** A start cancelled while OpenAI created the session (a hang-up, an
   * unpairing, a shutdown): no client will attach to it and no call owns it,
   * so close it through its sideband instead of leaving it open until OpenAI
   * gives up on it. Best effort, bounded by ATTACH_TIMEOUT_MS. */
  private closeOrphan(sessionId: string, key: string): void {
    let socket: LiveSocket;
    try {
      socket = this.deps.openSocket(this.deps.attachUrl(sessionId), key);
    } catch {
      return;
    }
    const done = () => {
      clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close(1000, "call cancelled"); } catch { /* already closed */ }
    };
    const timer = setTimeout(done, ATTACH_TIMEOUT_MS);
    timer.unref?.();
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ type: "session.close", event_id: "omb_cancelled" })); } catch { /* closing anyway */ }
      done();
    };
    socket.onerror = done;
    socket.onclose = () => clearTimeout(timer);
  }

  private hangUp(call: Call, reason: LiveEndReason): Promise<void> {
    if (call.state.status === "ended") return Promise.resolve();
    call.pendingEnd ??= reason;
    const done = new Promise<void>((resolve) => call.closeWaiters.push(resolve));
    // Already ending: session.close was sent and the close timer runs.
    if (call.state.status === "ending") return done;
    call.state.status = "ending";
    this.emit(call);
    if (!this.command(call, { type: "session.close" })) this.finish(call, call.pendingEnd);
    else this.later(call, () => this.finish(call, call.pendingEnd ?? reason), CLOSE_TIMEOUT_MS);
    return done;
  }

  private finish(call: Call, reason: LiveEndReason, error?: string): void {
    if (call.state.status === "ended") return;
    call.state.status = "ended";
    call.state.endReason = reason;
    if (error) call.state.error = error;
    for (const timer of call.timers) clearTimeout(timer);
    call.timers.clear();
    if (call.idleTimer) clearInterval(call.idleTimer);
    call.idleTimer = null;
    call.unsubscribe?.();
    call.unsubscribe = null;
    const socket = call.socket;
    call.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close(1000, "call ended"); } catch { /* already closed */ }
    }
    this.emit(call);
    this.writeRecord(call, reason);
    this.deps.log(liveCallSummaryLine({
      botId: call.state.botId,
      voice: call.state.voice,
      client: call.state.client,
      seconds: call.stats.seconds ?? (this.now() - call.state.startedAt) / 1000,
      delegations: call.stats.delegations,
      sentToBot: call.stats.sentToBot,
      answers: call.stats.answers,
      approvals: call.stats.approvals,
      notHeard: call.stats.notHeard,
      replies: call.stats.replies,
      end: reason,
      errors: call.stats.errors,
    }));
    if (this.call === call) this.call = null;
    for (const resolve of call.closeWaiters.splice(0)) resolve();
  }

  /** The one row a call that went live leaves in its chat (deps.recordCall):
   * its id, times and length, never anything said on it. A call that never
   * attached leaves none. Writing it may fail; the call still ends. */
  private writeRecord(call: Call, reason: LiveEndReason): void {
    if (!call.attached || !this.deps.recordCall) return;
    const endedAt = this.now();
    const record: LiveCallRecord = {
      callId: call.state.callId,
      botId: call.state.botId,
      client: call.state.client,
      startedAt: call.state.startedAt,
      endedAt,
      // OpenAI's usage seconds when it sent them, else wall clock: the summary line's source
      seconds: Math.max(0, Math.round(call.stats.seconds ?? (endedAt - call.state.startedAt) / 1000)),
      endReason: reason,
    };
    try {
      this.deps.recordCall({ threadId: call.state.threadId, botName: call.botName, record });
    } catch {
      this.recordError(call, "record");
    }
  }

  private checkIdle(call: Call): void {
    if (call.state.status !== "live" && call.state.status !== "connecting") return;
    // Talking keeps a call from idling out; it must not keep a signed-out person's call up.
    if (this.deps.signedIn && !this.deps.signedIn(call.auth)) {
      this.endSignedOut(call, null);
      return;
    }
    if (this.deps.activity(call.state.botId, call.state.threadId) === "working") {
      this.touch(call);
      this.maybeStatus(call);
      return;
    }
    const idleMs = this.deps.settings().idleMinutes * 60_000;
    if (this.now() - call.lastActivityAt >= idleMs) void this.hangUp(call, "idle");
  }

  // ── sideband events ──────────────────────────────────────────────────

  private onSideband(call: Call, raw: unknown): void {
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : "";
    // The sideband mirrors the audio; skip it without parsing megabytes of base64.
    if (!text || text.includes('"session.input_audio.append"') || text.includes('"session.output_audio.delta"')) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (call.state.status === "ended") return;
    switch (event.type) {
      case "session.started":
        if (call.state.status === "connecting") {
          call.state.status = "live";
          this.emit(call);
        }
        return;
      case "session.input_transcript.delta":
        call.transcript.addInput(String(event.delta ?? ""), Number(event.start_ms), Number(event.end_ms));
        call.heardThroughMs = Math.max(call.heardThroughMs, Number(event.end_ms) || 0);
        this.touch(call);
        if (call.approval && !call.approval.submitted) this.scheduleConsentCheck(call);
        return;
      case "session.output_transcript.delta":
        // its timing, when given, marks where the voice itself was talking
        call.transcript.addOutput(Number(event.start_ms), Number(event.end_ms));
        this.touch(call);
        return;
      case "session.delegation.created": {
        const delegation = event.delegation as { id?: unknown; target?: unknown } | undefined;
        if (delegation?.target !== "client" || typeof delegation.id !== "string") return;
        const id = delegation.id;
        const offset = Number(event.offset_ms) || 0;
        call.stats.delegations += 1;
        this.touch(call);
        this.later(call, () => this.delegate(call, id, offset), DELEGATION_SETTLE_MS);
        return;
      }
      case "session.usage.updated":
      case "session.closed": {
        const seconds = Number((event.usage as { seconds?: unknown } | undefined)?.seconds);
        if (Number.isFinite(seconds)) call.stats.seconds = seconds;
        if (event.type === "session.closed") {
          const reason = CLOSE_REASONS[String(event.reason)] ?? call.pendingEnd ?? "hung-up";
          this.finish(call, reason);
        }
        return;
      }
      case "error": {
        this.recordError(call, String((event.error as { code?: unknown } | undefined)?.code ?? "error"));
        return;
      }
      default:
        return;
    }
  }

  // ── voice → bot ──────────────────────────────────────────────────────

  private async delegate(call: Call, id: string, offsetMs: number): Promise<void> {
    if (call.state.status !== "live") return;
    const heard = call.transcript.takeRequestParts(offsetMs);
    const said = heard.text;
    if (call.approval && !call.approval.submitted) {
      // the voice's own words, heard back, are never the person's answer
      await this.decide(call, heard.withoutEcho, id, said);
      return;
    }
    const question = call.question;
    if (question && !question.submitted && said) {
      question.submitted = true;
      call.activeDelegation = id;
      call.stats.answers += 1;
      // The voice reading the question, heard back, is not part of the
      // answer. When that leaves nothing, the person spoke over the voice:
      // keep everything heard.
      const answer = heard.withoutEcho || said;
      const result = await this.respond(call, { auth: call.auth, threadId: call.state.threadId, requestId: question.requestId, behavior: "answer", message: answer, callId: call.state.callId }, id);
      if (!result) return;
      if (result.ok) {
        this.append(call, "thinking", LIVE_COPY.answerPassed, id);
      } else if (call.question === question) {
        question.submitted = false;
        this.append(call, "commentary", LIVE_COPY.saveFailed(result.error.trim().slice(0, 200)), id);
      }
      return;
    }
    const decision = call.lastDecision;
    if (!said && decision && offsetMs <= decision.throughMs + DECISION_ECHO_MS) {
      // The quiet-window rule already decided on these words; this is
      // GPT-Live delegating the same yes/no. Do not ask the user to repeat it.
      this.append(call, "thinking", decision.copy, id);
      return;
    }
    if (!said) {
      call.stats.notHeard += 1;
      this.append(call, "instructions", LIVE_COPY.notHeard, id);
      return;
    }
    call.activeDelegation = id;
    call.stats.sentToBot += 1;
    this.append(call, "thinking", LIVE_COPY.working, id);
    try {
      const result = await this.deps.send({ auth: call.auth, botId: call.state.botId, threadId: call.state.threadId, text: said, callId: call.state.callId });
      if (result.kind === "queued") call.queuedIds.add(result.queueId);
      else if (result.kind === "steered") {
        call.pendingCall.add(result.messageId);
        call.claimNextTerminal = true;
      } else call.pendingCall.add(result.messageId);
    } catch (error) {
      if (error instanceof LiveCallSignedOutError) {
        this.endSignedOut(call, id);
        return;
      }
      const detail = error instanceof Error ? error.message.trim().slice(0, 200) : "";
      this.recordError(call, "send-failed");
      this.append(call, "commentary", `The request could not be sent to ${call.botName}${detail ? `: ${detail}` : "."}`, id);
    }
  }

  /** `said`: the person's words; `heard`: everything heard, echo included
   * (asking again only makes sense when something was heard at all). */
  private async decide(call: Call, said: string, delegationId: string | null, heard: string = said): Promise<void> {
    if (call.state.status !== "live") return;
    const open = call.approval;
    if (!open || open.submitted) return;
    // Live's rule: hedges ("okay…", "sure") never decide on an open microphone
    const decision = spokenConsent(said, "live");
    if (!decision) {
      if (heard.trim()) this.append(call, "instructions", LIVE_COPY.notClear, delegationId);
      return;
    }
    call.transcript.consumeAll();
    open.submitted = true;
    call.stats.approvals += 1;
    const copy = decision === "allow" ? LIVE_COPY.granted : LIVE_COPY.denied;
    call.lastDecision = { throughMs: call.heardThroughMs, copy };
    this.append(call, "commentary", copy, delegationId);
    const result = await this.respond(call, {
      auth: call.auth,
      threadId: call.state.threadId,
      requestId: open.requestId,
      behavior: decision,
      message: decision === "deny" ? LIVE_COPY.deniedMessage : undefined,
    }, delegationId);
    if (!result) return;
    if (!result.ok && call.approval === open) {
      open.submitted = false;
      this.append(call, "commentary", LIVE_COPY.saveFailed(result.error.trim().slice(0, 200)), delegationId);
    }
  }

  private scheduleConsentCheck(call: Call): void {
    if (call.consentTimer) this.clear(call, call.consentTimer);
    call.consentTimer = this.later(call, () => {
      call.consentTimer = null;
      if (!call.approval || call.approval.submitted) return;
      const pending = call.transcript.pending({ skipEcho: true });
      return spokenConsent(pending, "live") ? this.decide(call, pending, call.activeDelegation) : undefined;
    }, CONSENT_SETTLE_MS);
  }

  // ── bot → voice ──────────────────────────────────────────────────────

  private onStoreChange(call: Call, change: StoreChange): void {
    if (call.state.status === "ended") return;
    // Listeners run inside the store's write; do the work after it.
    if (change.type === "thread.deleted" && change.threadId === call.state.threadId) this.soon(call, () => this.hangUp(call, "deleted"));
    else if (change.type === "bot.deleted" && change.botId === call.state.botId) this.soon(call, () => this.hangUp(call, "deleted"));
    else if ((change.type === "message" || change.type === "message.patch") && change.threadId === call.state.threadId) {
      const { type, message } = change;
      this.soon(call, () => this.onMessage(call, type, message));
    } else if (change.type === "bot" && change.botId === call.state.botId) this.soon(call, () => this.onBotChange(call));
  }

  private onBotChange(call: Call): void {
    if (call.state.status === "ended") return;
    const activity = this.deps.activity(call.state.botId, call.state.threadId);
    const was = call.lastActivity;
    call.lastActivity = activity;
    if (activity === "working") this.touch(call);
    if (activity === "working" && (was === "idle" || call.workStartedAt === null)) this.beginWork(call);
    if (activity === "idle") call.workStartedAt = null;
    if (was === "idle" || activity !== "idle") return;
    // A turn settled. If it carried a call request and said nothing, say so.
    this.forgetUnqueued(call);
    if (call.approval || call.question || call.queuedIds.size) return;
    if (!call.pendingCall.size && !call.claimNextTerminal) return;
    call.pendingCall.clear();
    call.claimNextTerminal = false;
    this.append(call, "commentary", LIVE_COPY.noAnswer);
  }

  /** A queued call request leaves queuedIds when it is delivered (onMessage).
   * Edited or cancelled in a client, it leaves the queue without arriving;
   * waiting for it would keep "the result is in the chat" unsaid for good. */
  private forgetUnqueued(call: Call): void {
    for (const queueId of call.queuedIds) {
      if (!this.deps.queued(call.state.botId, call.state.threadId, queueId)) call.queuedIds.delete(queueId);
    }
  }

  private onMessage(call: Call, type: "message" | "message.patch", message: Message): void {
    if (call.state.status === "ended") return;
    this.touch(call);
    if (type === "message") this.trackDrain(call, message);
    if (message.role === "user") {
      if (type !== "message" || message.kind !== "text") return;
      if (message.via === "call") {
        if (message.queueId) call.queuedIds.delete(message.queueId);
        call.pendingCall.add(message.id);
      } else if (this.typedByCaller(call, message)) {
        // Only the bot answers a typed message. Telling the voice now made it
        // answer too, and then again when the bot's answer was relayed.
        call.typedTexts.set(message.id, message.text ?? "");
      }
      return;
    }
    if (message.kind === "options") {
      this.onCard(call, message);
      return;
    }
    if (message.kind === "connector" || message.kind === "secret") {
      this.onSetupCard(call, message);
      return;
    }
    if (message.kind === "activity") {
      if (type !== "message" || !message.tool) return;
      if (call.workStartedAt !== null) {
        call.workSteps += 1;
        call.lastStep = liveStepLabel(message.tool);
        call.lastStepAt = this.now();
      }
      if (!this.mayNarrate(call)) return;
      if (message.tool.spoken && this.now() - call.lastProgressAt > PROGRESS_INTERVAL_MS) {
        call.lastProgressAt = this.now();
        this.append(call, "thinking", LIVE_COPY.progress(message.tool.spoken));
      }
      return;
    }
    if (message.kind === "text" && message.turnTerminal && !call.spokenAnswers.has(message.id)) this.onAnswer(call, message);
  }

  /** A line the caller typed in a client (every client sends a sendId with
   * what is typed), as the same person. Not a peer bot's line (ask_bot,
   * start_thread, an aside: the answer goes back to that bot), not a line a
   * routine, a webhook or the local API added (no sendId, or via "api"), not
   * a line a worker relayed for someone else (the Slack relay, any guarded
   * send: relayed), and not another member's line in a shared workspace. */
  private typedByCaller(call: Call, message: Message): boolean {
    if (message.peerAsk || message.aside || message.relayed || message.via === "api" || !message.sendId) return false;
    return message.sender?.id === call.personKey;
  }

  /** Keep the lines one drain delivered together: they arrive back to back,
   * and any other message closes the batch. */
  private trackDrain(call: Call, message: Message): void {
    if (message.role !== "user" || message.kind !== "text" || !message.queueId) {
      call.drainBatch = null;
      return;
    }
    call.drainBatch ??= [];
    call.drainBatch.push(message.id);
    call.batches.set(message.id, call.drainBatch);
    if (call.batches.size > 200) call.batches.delete(call.batches.keys().next().value!);
  }

  private onAnswer(call: Call, message: Message): void {
    const request = message.requestMessageId;
    // A drained turn answers every line of its batch, not only the last one.
    const batch = request === undefined ? [] : call.batches.get(request) ?? [request];
    // A batch that holds a spoken line is the call's: answered aloud, even
    // when a typed line came last.
    const forCall = batch.some((id) => call.pendingCall.has(id)) || call.claimNextTerminal || (request === undefined && call.pendingCall.size > 0);
    const typed = !forCall && request !== undefined ? call.typedTexts.get(request) : undefined;
    const settle = () => {
      for (const id of batch) {
        call.pendingCall.delete(id);
        call.typedTexts.delete(id);
        call.batches.delete(id);
      }
    };
    if (!forCall && typed === undefined) return;
    if (!forCall && !this.deps.settings().readTypedReplies) {
      // Off means nothing about a typed exchange reaches OpenAI, not even as context.
      settle();
      call.spokenAnswers.add(message.id);
      return;
    }
    const lead = !forCall && typed !== undefined ? [LIVE_COPY.typedAnswerLead(typed)] : [];
    const utterances = this.deps.speakable(message.text ?? "");
    if (!utterances.length) return;
    const chunks = commentaryChunks([...lead, ...utterances]);
    if (!chunks.length) return;
    call.spokenAnswers.add(message.id);
    settle();
    if (forCall) {
      if (request === undefined || call.claimNextTerminal) call.pendingCall.clear();
      call.claimNextTerminal = false;
    }
    call.stats.replies += 1;
    const delegationId = forCall ? call.activeDelegation : null;
    for (const chunk of chunks) this.append(call, "commentary", chunk, delegationId);
  }

  private onCard(call: Call, message: Message): void {
    const card = message.card;
    if (!card?.requestId) return;
    const kind = liveCardKind(card);
    if (!kind) {
      this.onCardSettled(call, card.requestId);
      return;
    }
    if (call.announced.has(card.requestId)) return;
    if ((kind === "approval" || kind === "question") && (call.approval || call.question)) {
      if (!call.waitingCards.some((waiting) => waiting.card?.requestId === card.requestId)) call.waitingCards.push(message);
      return;
    }
    call.announced.add(card.requestId);
    if (kind === "review") {
      this.append(call, "instructions", spokenReviewPrompt(card));
    } else if (kind === "approval") {
      call.approval = { requestId: card.requestId, messageId: message.id, submitted: false };
      call.transcript.consumeAll();
      this.append(call, "instructions", LIVE_COPY.permissionRequest(spokenApprovalPrompt(card)));
    } else {
      call.question = { requestId: card.requestId, messageId: message.id, submitted: false };
      call.transcript.consumeAll();
      this.append(call, "instructions", spokenQuestionPrompt(card));
    }
  }

  /** A connect-an-app or credential card: the bot waits on the person in
   * the chat. The voice says so once; neither can be done by voice, and a
   * credential must never be spoken into the call. */
  private onSetupCard(call: Call, message: Message): void {
    const { connector, secret } = message;
    const waiting = message.kind === "connector"
      ? Boolean(connector && connector.status !== "connected" && !connector.dismissed && !connector.resumed)
      : Boolean(secret && !secret.provided && !secret.dismissed && !secret.superseded && !secret.resumed);
    const key = `${message.kind}:${message.id}`;
    if (!waiting || call.announced.has(key)) return;
    call.announced.add(key);
    this.append(call, "instructions", connector ? spokenConnectorPrompt(connector.label) : spokenSecretPrompt(secret?.label ?? ""));
  }

  private onCardSettled(call: Call, requestId: string): void {
    call.waitingCards = call.waitingCards.filter((waiting) => waiting.card?.requestId !== requestId);
    const open = call.approval?.requestId === requestId ? call.approval : call.question?.requestId === requestId ? call.question : null;
    if (!open) return;
    if (call.approval === open) call.approval = null;
    else call.question = null;
    if (!open.submitted) this.append(call, "thinking", LIVE_COPY.answeredInChat, null);
    const next = call.waitingCards.shift();
    if (next) this.onCard(call, next);
  }

  // ── status notes ─────────────────────────────────────────────────────

  private beginWork(call: Call): void {
    const now = this.now();
    call.workStartedAt = now;
    call.workSteps = 0;
    call.lastStep = null;
    call.lastStepAt = now;
    call.lastStatusAt = now;
  }

  /** A quiet fact for the voice while the bot works, so "is it stuck?" gets an
   * answer from the real state instead of a guess (or a question steered into
   * the running turn). Names steps, never their arguments. */
  private maybeStatus(call: Call): void {
    if (call.workStartedAt === null) {
      this.beginWork(call);
      return;
    }
    const now = this.now();
    if (now - call.lastStatusAt < STATUS_INTERVAL_MS) return;
    call.lastStatusAt = now;
    if (!this.mayNarrate(call)) return;
    this.append(call, "thinking", LIVE_COPY.status(now - call.workStartedAt, call.workSteps, call.lastStep, now - call.lastStepAt), null);
  }

  /** Whether the voice may hear about the bot's current work (progress and
   * status notes). With typed replies off, only work on a spoken request:
   * the steps the bot takes for a typed message are about that exchange. */
  private mayNarrate(call: Call): boolean {
    return this.deps.settings().readTypedReplies || call.pendingCall.size > 0 || call.claimNextTerminal;
  }

  // ── plumbing ─────────────────────────────────────────────────────────

  private append(call: Call, kind: AppendKind, content: string, delegationId: string | null = call.activeDelegation): boolean {
    return this.command(call, { type: `session.${kind}.append`, delegation_id: delegationId, content: clampAppend(content) });
  }

  private command(call: Call, event: Record<string, unknown>): boolean {
    const socket = call.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || call.state.status === "ended") return false;
    try {
      socket.send(JSON.stringify({ ...event, event_id: `omb_${++call.eventCounter}` }));
      return true;
    } catch {
      return false;
    }
  }

  private emit(call: Call): void {
    try {
      this.deps.broadcast({ kind: "live.call", botId: call.state.botId, threadId: call.state.threadId, call: { ...call.state } });
    } catch {
      this.recordError(call, "broadcast");
    }
  }

  private touch(call: Call): void {
    call.lastActivityAt = this.now();
  }

  private later(call: Call, fn: () => unknown, ms: number): Timer {
    const timer = setTimeout(() => {
      call.timers.delete(timer);
      this.guarded(call, fn);
    }, ms);
    timer.unref?.();
    call.timers.add(timer);
    return timer;
  }

  /** Run deferred work in the next microtask, after the store's write. */
  private soon(call: Call, fn: () => unknown): void {
    queueMicrotask(() => this.guarded(call, fn));
  }

  /** Timers, microtasks and socket events run outside any caller's
   * try/catch, and the server has no unhandled-rejection handler: a bug in
   * the voice relay must cost a counter, never the harness process. */
  private guarded(call: Call, fn: () => unknown): void {
    try {
      const result = fn();
      if (result instanceof Promise) result.catch(() => this.recordError(call, "internal"));
    } catch {
      this.recordError(call, "internal");
    }
  }

  /** Null when the call is ending because its sign-in ended: say nothing more. */
  private async respond(call: Call, input: Parameters<LiveCallDeps["respond"]>[0], delegationId: string | null): Promise<LiveRespondResult | null> {
    try {
      return await this.deps.respond(input);
    } catch (error) {
      if (error instanceof LiveCallSignedOutError) {
        this.endSignedOut(call, delegationId);
        return null;
      }
      this.recordError(call, "respond-failed");
      return { ok: false, error: "" };
    }
  }

  /** The sign-in (or paired phone) that started the call ended: say so once,
   * then hang up. False when the call was already ending. */
  private endSignedOut(call: Call, delegationId: string | null, why: string = LIVE_COPY.signedOut): boolean {
    if (call.state.status === "ending" || call.state.status === "ended") return false;
    this.recordError(call, "signed-out");
    this.append(call, "commentary", why, delegationId);
    call.state.error = why;
    void this.hangUp(call, "signed-out");
    return true;
  }

  private recordError(call: Call, code: string): void {
    if (call.stats.errors.length < MAX_ERRORS) call.stats.errors.push(code);
  }

  private clear(call: Call, timer: Timer): void {
    clearTimeout(timer);
    call.timers.delete(timer);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
