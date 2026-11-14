// An ElevenLabs Agents Live call: this page holds the conversation's WebSocket (a signed URL the harness asked for, so the
// key stays on the harness), the microphone and the agent's audio, and FishCall relays what was said to the harness as on a
// Fish Audio call. The agent allows this conversation to set its prompt, so the call's instructions go in the first message.
import type { LiveElevenLabsSession } from "../../shared/wire";
import { browserGeminiAudio, type GeminiAudio } from "./live-call-gemini-audio";
import type { FishAgentSession, FishSessionOptions, FishSessionStarter } from "./live-call-fish";
import { decodeBase64, encodeBase64, type GeminiSocket } from "./live-call-gemini";

/** The agent is set up to answer with 16 kHz PCM; the first message names the format. */
const DEFAULT_RATE = 16_000;
/** ElevenLabs sends no end of the agent's turn, so a pause in its audio this long ends it, not a late chunk. */
const IDLE_GRACE_MS = 300;

export interface ElevenLabsSessionDeps {
  openSocket(url: string): GeminiSocket;
  /** Plays the agent at `rate` Hz. */
  audio(rate: number): GeminiAudio;
}

const browserDeps: ElevenLabsSessionDeps = {
  openSocket: (url) => new WebSocket(url) as unknown as GeminiSocket,
  audio: browserGeminiAudio,
};

/** ElevenLabs Agents WebSocket events this call reads. */
type ServerMessage = {
  type?: string;
  conversation_initiation_metadata_event?: { conversation_id?: string; agent_output_audio_format?: string };
  audio_event?: { audio_base_64?: string; event_id?: number };
  interruption_event?: { event_id?: number };
  user_transcription_event?: { user_transcript?: string };
  agent_response_event?: { agent_response?: string };
  ping_event?: { event_id?: number };
  client_tool_call?: { tool_name?: string; tool_call_id?: string; parameters?: Record<string, unknown> };
};

type Outgoing = { type: "client_tool_result" | "user_message" | "contextual_update" } & Record<string, unknown>;

export function elevenLabsSessionStarter(deps: ElevenLabsSessionDeps = browserDeps): FishSessionStarter<LiveElevenLabsSession> {
  return (options) => new ElevenLabsLiveSession(options, deps).start();
}

export const startElevenLabsLiveSession = elevenLabsSessionStarter();

/** The playback rate of a `pcm_<rate>` format. */
export function elevenLabsPlaybackRate(format: string | undefined): number {
  const rate = Number(/^pcm_(\d{4,6})$/.exec(format ?? "")?.[1]);
  return rate >= 8_000 && rate <= 48_000 ? rate : DEFAULT_RATE;
}

class ElevenLabsLiveSession implements FishAgentSession {
  private readonly options: FishSessionOptions<LiveElevenLabsSession>;
  private readonly deps: ElevenLabsSessionDeps;
  private socket: GeminiSocket | null = null;
  private audio: GeminiAudio | null = null;
  private ready = false;
  private ended = false;
  private muted = false;
  /** Tool answers and the bot's words, in order; a user message interrupts the agent, so it waits while the agent speaks. */
  private outbox: Outgoing[] = [];
  private segment = 0;
  private speaking = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Audio of an interrupted answer still on its way is not played. */
  private interruptedAt = -1;

  constructor(options: FishSessionOptions<LiveElevenLabsSession>, deps: ElevenLabsSessionDeps) {
    this.options = options;
    this.deps = deps;
  }

  /** Resolves once ElevenLabs has started the conversation and the microphone is open. */
  start(): Promise<FishAgentSession> {
    return new Promise((resolve, reject) => {
      const session = this.options.sessionToken;
      const socket = this.deps.openSocket(session.signed_url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let started = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: { agent: { prompt: { prompt: session.instructions } } },
        }));
      };
      socket.onmessage = (event) => {
        const message = this.parse(event.data);
        if (!message) return;
        if (message.type === "conversation_initiation_metadata" && !started) {
          started = true;
          void this.open(elevenLabsPlaybackRate(message.conversation_initiation_metadata_event?.agent_output_audio_format), resolve, reject);
          return;
        }
        this.onMessage(message);
      };
      socket.onerror = () => undefined;
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.ready) return this.lost();
        this.shut();
        if (!started) reject(Object.assign(new Error("ElevenLabs closed the call before it started."), { code: `elevenlabs_${event.code}` }));
      };
    });
  }

  private async open(rate: number, resolve: (session: FishAgentSession) => void, reject: (error: unknown) => void): Promise<void> {
    try {
      this.audio = this.deps.audio(rate);
      this.audio.onIdle = () => this.playbackPaused();
      await this.audio.startMic((pcm) => this.sendAudio(pcm));
    } catch (error) {
      this.shut();
      return reject(error);
    }
    if (this.ended) return resolve(this);
    if (!this.socket) {
      this.shut();
      return reject(Object.assign(new Error("ElevenLabs closed the call before it started."), { code: "elevenlabs_closed" }));
    }
    this.ready = true;
    this.options.callbacks.onConnect({ sessionId: this.options.sessionToken.session_id });
    resolve(this);
    this.flush();
  }

  sendUserMessage(text: string, options?: { audio?: boolean }): void {
    // A contextual update joins what the agent knows without an answer; a user message is answered aloud.
    this.post(options?.audio === false ? { type: "contextual_update", text } : { type: "user_message", text });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    this.muted = muted;
  }

  async end(): Promise<void> {
    this.ended = true;
    this.shut();
  }

  private shut(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
    }
    this.clearIdleTimer();
    this.audio?.close();
    this.audio = null;
  }

  /** ElevenLabs ended the conversation or the connection dropped: the call cannot go on over a new one. */
  private lost(): void {
    if (this.ended) return;
    this.ended = true;
    this.shut();
    this.options.callbacks.onDisconnect({ reason: "connection_lost" });
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
    switch (message.type) {
      case "ping":
        return this.send({ type: "pong", event_id: message.ping_event?.event_id });
      case "audio": {
        const data = message.audio_event?.audio_base_64;
        const id = message.audio_event?.event_id;
        if (!data || !this.audio || (id !== undefined && id <= this.interruptedAt)) return;
        this.clearIdleTimer();
        this.audio.play(decodeBase64(data));
        if (!this.speaking) {
          this.speaking = true;
          this.options.callbacks.onModeChange("speaking");
        }
        return;
      }
      case "user_transcript": {
        const text = message.user_transcription_event?.user_transcript?.trim();
        if (!text) return;
        this.options.callbacks.onUserTranscript({ segmentId: `s${this.segment}`, text, final: true });
        this.segment += 1;
        return;
      }
      case "agent_response": {
        const text = message.agent_response_event?.agent_response?.trim();
        if (text) this.options.callbacks.onAgentResponseDelta({ segmentId: `a${this.segment}`, text });
        return;
      }
      case "interruption":
        this.interruptedAt = message.interruption_event?.event_id ?? this.interruptedAt;
        this.clearIdleTimer();
        this.audio?.flush();
        return this.playbackIdle();
      case "client_tool_call":
        return this.onToolCall(message.client_tool_call ?? {});
    }
  }

  private playbackPaused(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.playbackIdle();
    }, IDLE_GRACE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private playbackIdle(): void {
    if (!this.speaking) return;
    this.speaking = false;
    this.options.callbacks.onModeChange("listening");
    this.flush();
  }

  private onToolCall(call: { tool_name?: string; tool_call_id?: string; parameters?: Record<string, unknown> }): void {
    const id = call.tool_call_id ?? "";
    const name = call.tool_name ?? "";
    const tool = this.options.clientTools[name];
    const answer = tool ? tool(call.parameters ?? {}, { callId: id }) : Promise.resolve(`There is no tool named ${name}.`);
    void answer.then((result) => {
      this.post({ type: "client_tool_result", tool_call_id: id, result: String(result), is_error: !tool });
    }, () => {
      this.post({ type: "client_tool_result", tool_call_id: id, result: "The request failed.", is_error: true });
    });
  }

  private sendAudio(pcm: ArrayBuffer): void {
    if (!this.ready || this.muted) return;
    this.send({ user_audio_chunk: encodeBase64(pcm) });
  }

  /** Sent now, or kept until the conversation has started and, for a user message, until the agent stops speaking. */
  private post(message: Outgoing): void {
    if (this.ended) return;
    this.outbox.push(message);
    this.flush();
  }

  private flush(): void {
    while (this.ready && this.socket?.readyState === 1 && this.outbox.length && !(this.speaking && this.outbox[0]!.type === "user_message")) {
      this.send(this.outbox.shift());
    }
  }

  private send(message: unknown): void {
    if (this.ended || this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify(message));
  }
}
