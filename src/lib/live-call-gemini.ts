// A Gemini Live call: this page holds Gemini's WebSocket, the microphone and the agent's audio, and FishCall relays what
// was said to the harness as on a Fish Audio call. The token's setup is locked by the harness (server/live-gemini.ts), so
// the setup sent here only names the model and the session to resume.
import type { LiveGeminiSession } from "../../shared/wire";
import { browserGeminiAudio, type GeminiAudio } from "./live-call-gemini-audio";
import { FISH_UPDATE_PREFIX, type FishAgentSession, type FishSessionOptions, type FishSessionStarter } from "./live-call-fish";

const MIC_MIME = "audio/pcm;rate=16000";
/** Gemini ends each connection after about 10 minutes; the call goes on over a new one, this many times at most. */
const MAX_RECONNECTS = 12;
/** Gemini can call a tool before it sends what it heard; the call waits this long after the last words heard... */
const HEARD_QUIET_MS = 400;
/** ...and this long at most, since a call can come without words, e.g. on the bot's update. */
const HEARD_WAIT_MS = 2_000;

type ToolCall = { id?: string; name?: string; args?: Record<string, unknown> };
type Outgoing = { toolResponse: unknown; callId: string; text: string } | { clientContent: unknown };

/** The part of the browser WebSocket a call uses. */
export interface GeminiSocket {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface GeminiSessionDeps {
  openSocket(url: string): GeminiSocket;
  audio(): GeminiAudio;
}

const browserDeps: GeminiSessionDeps = {
  openSocket: (url) => new WebSocket(url) as unknown as GeminiSocket,
  audio: browserGeminiAudio,
};

type ServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: ToolCall[] };
  goAway?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
};

export function geminiSessionStarter(deps: GeminiSessionDeps = browserDeps): FishSessionStarter<LiveGeminiSession> {
  return (options) => new GeminiLiveSession(options, deps).start();
}

export const startGeminiLiveSession = geminiSessionStarter();

function decodeBase64(data: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

class GeminiLiveSession implements FishAgentSession {
  private readonly options: FishSessionOptions<LiveGeminiSession>;
  private readonly deps: GeminiSessionDeps;
  private socket: GeminiSocket | null = null;
  private audio: GeminiAudio | null = null;
  private ready = false;
  private ended = false;
  private muted = false;
  private handle: string | null = null;
  private reconnects = 0;
  private wentAway = false;
  /** The connection now being resumed was ended by Gemini, e.g. at the call's time limit. */
  private resumingAfterGoAway = false;
  /** A connection is set up and can take messages. */
  private linked = false;
  /** Tool answers and the bot's words, in order, held while there is no connection or, for words, while the agent speaks:
   * client content interrupts what Gemini is saying. */
  private outbox: Outgoing[] = [];
  /** Tool calls made since the last resumption handle: a session resumed with that handle has never seen them. */
  private callsAfterHandle = new Set<string>();
  /** Tool calls the session on the current connection does not know; their answers go to Gemini as the bot's words. */
  private unknownCalls = new Set<string>();
  private segment = 0;
  private heard = "";
  /** What the agent has said this turn: the caption shows the whole turn, Gemini sends it in pieces. */
  private said = "";
  private speaking = false;
  private turnDone = false;
  /** What the person said has been captioned as final, and no tool call has gone with it yet. */
  private heardThisTurn = false;
  /** Tool calls waiting for what the person said, so the harness gets the request before the delegation. */
  private heldCalls: ToolCall[] = [];
  private heldQuiet: ReturnType<typeof setTimeout> | null = null;
  private heldLimit: ReturnType<typeof setTimeout> | null = null;

  constructor(options: FishSessionOptions<LiveGeminiSession>, deps: GeminiSessionDeps) {
    this.options = options;
    this.deps = deps;
  }

  /** Resolves once Gemini has taken the setup and the microphone is open. */
  start(): Promise<FishAgentSession> {
    return new Promise((resolve, reject) => {
      this.connect(async () => {
        try {
          this.audio = this.deps.audio();
          this.audio.onIdle = () => this.playbackIdle();
          await this.audio.startMic((pcm) => this.sendAudio(pcm));
        } catch (error) {
          this.shut();
          return reject(error);
        }
        if (this.ended) return resolve(this);
        this.ready = true;
        this.options.callbacks.onConnect({ sessionId: this.options.sessionToken.session_id });
        resolve(this);
      }, (code) => reject(Object.assign(new Error("Gemini closed the call before it started."), { code: `gemini_${code}` })));
    });
  }

  sendUserMessage(text: string, options?: { audio?: boolean }): void {
    // Without turnComplete the words join the context and Gemini does not answer them.
    this.post({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: options?.audio !== false } });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (muted && !this.muted) this.send({ realtimeInput: { audioStreamEnd: true } });
    // Audio captured while muted that has not made a whole chunk yet is never sent.
    if (!muted && this.muted) this.audio?.dropMic();
    this.muted = muted;
  }

  async end(): Promise<void> {
    this.ended = true;
    this.shut();
  }

  private shut(): void {
    this.clearHeldTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
    }
    this.audio?.close();
    this.audio = null;
  }

  private connect(onSetup: () => void, onEarlyClose: (code: number) => void): void {
    const session = this.options.sessionToken;
    const socket = this.deps.openSocket(`${session.ws_url}?access_token=${encodeURIComponent(session.token)}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let setUp = false;
    socket.onopen = () => {
      socket.send(JSON.stringify({ setup: { model: session.model, sessionResumption: this.handle ? { handle: this.handle } : {} } }));
    };
    socket.onmessage = (event) => {
      const message = this.parse(event.data);
      if (!message) return;
      if (message.setupComplete !== undefined && !setUp) {
        setUp = true;
        this.linked = true;
        onSetup();
        this.flush();
        return;
      }
      this.onMessage(message);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.linked = false;
      if (setUp) return this.lost(true);
      // A resume Gemini refused, e.g. past the token's time limit, is not tried again.
      if (this.ready) return this.lost(false);
      this.shut();
      onEarlyClose(event.code);
    };
  }

  /** A connection Gemini ended goes on over a new one while the session can be resumed. */
  private lost(resumable: boolean): void {
    if (this.ended) return;
    if (resumable && this.handle && this.reconnects < MAX_RECONNECTS) {
      this.reconnects += 1;
      this.resumingAfterGoAway = this.wentAway;
      this.wentAway = false;
      this.forgetCallsAfterHandle();
      this.connect(() => undefined, () => undefined);
      return;
    }
    const reason = this.wentAway || (!resumable && this.resumingAfterGoAway) ? "conversation_timeout" : "connection_lost";
    this.ended = true;
    this.shut();
    this.options.callbacks.onDisconnect({ reason });
  }

  private parse(data: unknown): ServerMessage | null {
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      const message = JSON.parse(text) as unknown;
      return message && typeof message === "object" ? message as ServerMessage : null;
    } catch {
      return null;
    }
  }

  private onMessage(message: ServerMessage): void {
    const content = message.serverContent;
    if (content) {
      const heard = content.inputTranscription?.text;
      if (heard) {
        this.heard += heard;
        this.options.callbacks.onUserTranscript({ segmentId: `s${this.segment}`, text: this.heard, final: false });
        if (this.heldCalls.length) this.releaseWhenQuiet();
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (!part.inlineData?.data || !part.inlineData.mimeType?.startsWith("audio/")) continue;
        this.finishHeard();
        this.turnDone = false;
        this.audio?.play(decodeBase64(part.inlineData.data));
        if (!this.speaking) {
          this.speaking = true;
          this.options.callbacks.onModeChange("speaking");
        }
      }
      const said = content.outputTranscription?.text;
      if (said) {
        this.finishHeard();
        this.said += said;
        this.options.callbacks.onAgentResponseDelta({ segmentId: `a${this.segment}`, text: this.said });
      }
      if (content.interrupted || content.turnComplete) this.said = "";
      if (content.interrupted) {
        this.heardThisTurn = false;
        this.audio?.flush();
        this.turnDone = true;
        this.playbackIdle();
      }
      if (content.turnComplete) {
        this.finishHeard();
        this.heardThisTurn = false;
        this.turnDone = true;
        if (this.audio?.idle() !== false) this.playbackIdle();
      }
    }
    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length) this.onToolCalls(calls);
    if (message.goAway !== undefined) this.wentAway = true;
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && typeof update.newHandle === "string" && update.newHandle) {
      this.handle = update.newHandle;
      this.callsAfterHandle.clear();
    }
  }

  private finishHeard(): void {
    if (!this.heard) return;
    const text = this.heard;
    this.heard = "";
    this.options.callbacks.onUserTranscript({ segmentId: `s${this.segment}`, text, final: true });
    this.segment += 1;
    this.heardThisTurn = true;
    this.releaseCalls();
  }

  private playbackIdle(): void {
    if (!this.speaking || !this.turnDone) return;
    this.speaking = false;
    this.options.callbacks.onModeChange("listening");
    this.flush();
  }

  private onToolCalls(calls: ToolCall[]): void {
    // The harness reads the request from what it heard, so that goes first: Gemini may send the call before the words, or
    // while they are still coming.
    for (const call of calls) this.callsAfterHandle.add(call.id ?? "");
    this.heldCalls.push(...calls);
    if (this.heard) this.releaseWhenQuiet();
    else if (this.heardThisTurn) return this.releaseCalls();
    this.heldLimit ??= setTimeout(() => this.releaseCalls(), HEARD_WAIT_MS);
  }

  private releaseWhenQuiet(): void {
    if (this.heldQuiet) clearTimeout(this.heldQuiet);
    this.heldQuiet = setTimeout(() => this.releaseCalls(), HEARD_QUIET_MS);
  }

  private releaseCalls(): void {
    if (!this.heldCalls.length) return;
    const calls = this.heldCalls;
    this.heldCalls = [];
    this.clearHeldTimers();
    this.finishHeard();
    // The words heard go with these calls; a later call waits for its own.
    this.heardThisTurn = false;
    calls.forEach((call) => this.runToolCall(call));
  }

  private clearHeldTimers(): void {
    if (this.heldQuiet) clearTimeout(this.heldQuiet);
    if (this.heldLimit) clearTimeout(this.heldLimit);
    this.heldQuiet = null;
    this.heldLimit = null;
  }

  private runToolCall(call: ToolCall): void {
    if (this.ended) return;
    const id = call.id ?? "";
    const name = call.name ?? "";
    const tool = this.options.clientTools[name];
    const answer = tool ? tool(call.args ?? {}, { callId: id }) : Promise.resolve(`There is no tool named ${name}.`);
    void answer.then((result) => {
      const text = String(result);
      this.post({ toolResponse: { functionResponses: [{ id, name, response: { result: text, scheduling: "WHEN_IDLE" } }] }, callId: id, text });
    }, () => undefined);
  }

  /** On resuming with a handle older than some tool calls, their answers reach Gemini as the bot's words instead. */
  private forgetCallsAfterHandle(): void {
    for (const id of this.callsAfterHandle) this.unknownCalls.add(id);
    this.callsAfterHandle.clear();
    this.outbox = this.outbox.map((message) => this.forKnownCall(message));
  }

  private forKnownCall(message: Outgoing): Outgoing {
    if (!("toolResponse" in message) || !this.unknownCalls.has(message.callId)) return message;
    return { clientContent: { turns: [{ role: "user", parts: [{ text: `${FISH_UPDATE_PREFIX} ${message.text}` }] }], turnComplete: true } };
  }

  private sendAudio(pcm: ArrayBuffer): void {
    if (!this.ready || this.muted) return;
    this.send({ realtimeInput: { audio: { mimeType: MIC_MIME, data: encodeBase64(pcm) } } });
  }

  /** Sent now, or kept for the next connection and, for the bot's words, for when the agent stops speaking. */
  private post(message: Outgoing): void {
    if (this.ended) return;
    this.outbox.push(this.forKnownCall(message));
    this.flush();
  }

  private flush(): void {
    while (this.linked && this.socket?.readyState === 1 && this.outbox.length && !(this.speaking && "clientContent" in this.outbox[0])) {
      const message = this.outbox.shift()!;
      this.send("toolResponse" in message ? { toolResponse: message.toolResponse } : message);
    }
  }

  private send(message: unknown): void {
    if (this.ended || !this.linked || this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify(message));
  }
}
