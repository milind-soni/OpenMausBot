import WebSocket from "ws";
import type { LivePlaybackCredit } from "../shared/wire.ts";
import type { LiveSocket } from "./live-call-controller.ts";
import type { LiveEndpoint } from "./live-call.ts";
import { qwenModelSchema, qwenVoiceSchema } from "./qwen-live-config.ts";
import { livePlaybackCreditSchema } from "./live-media-protocol.ts";

const MAX_QUEUED_AUDIO_BYTES = 48_000 * 120;

export interface LiveMediaConsumer {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface QwenSocketInput {
  endpoint: LiveEndpoint;
  key: string;
  voice: string;
  instructions: string;
  history?: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
  upstream?: LiveSocket;
}

interface SpokenInput {
  start: number;
  end: number;
  text?: string;
  consumed: boolean;
  echoUnsafe: boolean;
}
interface ToolSignal {
  id: string;
  responseId: string;
  finished: boolean;
  accepted?: boolean;
  requestId?: string;
  threadId?: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface SpokenNote {
  callId?: string;
  status: string;
  result: string;
  requestId?: string;
  threadId?: string;
}

export class QwenLiveSocket implements LiveSocket {
  readyState = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  private readonly upstream: LiveSocket;
  private media: LiveMediaConsumer | null = null;
  private readonly inputs = new Map<string, SpokenInput>();
  private readonly responses = new Map<string, { inputId?: string; done?: boolean }>();
  private readonly tools = new Map<string, ToolSignal>();
  private readonly committed: string[] = [];
  private readonly notes: SpokenNote[] = [];
  private active: { id?: string; note?: SpokenNote; interrupted?: boolean } | null = null;
  private readonly suppressedAudio = new Set<string>();
  private speaking = false;
  private awaitingTurn = false;
  private playbackUnproven = false;
  private readonly history: NonNullable<QwenSocketInput["history"]>;
  private readonly startedAt = Date.now();
  private inputBytes = 0;
  private readonly audioQueue: Buffer[] = [];
  private audioBytes = 0;
  private audioTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackFlow: "credit-v1" | undefined;
  private playbackEpoch = 0;
  private playbackSeq = 0;
  private playbackBytes = 0;
  private playbackRunning = false;
  private lastAudioAt = -Infinity;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: QwenSocketInput) {
    const url = new URL(input.endpoint.apiBase);
    const official = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname)
      || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname);
    if (input.endpoint.provider !== "qwen" || url.protocol !== "wss:" || !official || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/api-ws/v1/realtime") throw new Error("Invalid Qwen Live target.");
    qwenModelSchema.parse(input.endpoint.model);
    qwenVoiceSchema.parse(input.voice);
    this.history = input.history ?? [];
    this.upstream = input.upstream ?? new WebSocket(`${input.endpoint.apiBase}?model=${encodeURIComponent(input.endpoint.model)}`, {
      headers: { authorization: `Bearer ${input.key}` }, followRedirects: false, maxPayload: 256 * 1024, perMessageDeflate: false,
    }) as unknown as LiveSocket;
    this.upstream.onopen = () => this.write({ type: "session.update", session: {
      modalities: ["text", "audio"], voice: input.voice, instructions: input.instructions,
      input_audio_format: "pcm", output_audio_format: "pcm",
      tools: [{ type: "function", function: { name: "delegate_to_bot", description: "Ask the bot to handle the person's completed spoken request. No parameters.", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
      turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
    } });
    this.upstream.onmessage = ({ data }) => {
      if (this.readyState === 3) return;
      try {
        if (Buffer.byteLength(String(data)) > 256 * 1024) { this.close(1008, "provider event limit"); return; }
        this.receive(JSON.parse(String(data)) as Record<string, unknown>);
        if (this.inputs.size > 256 || this.responses.size > 256 || this.tools.size > 256 || this.notes.length > 64) this.close(1008, "call state limit");
      }
      catch { this.close(1002, "invalid provider event"); }
    };
    this.upstream.onerror = () => {
      this.emit({ type: "error", error: { code: "qwen-provider-transport" } });
      this.onerror?.({});
      this.close(1011, "provider connection failed");
    };
    this.upstream.onclose = (event) => {
      const code = (event as { code?: unknown } | undefined)?.code;
      const safeCode = typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1006;
      this.emit({ type: "error", error: { code: `qwen-provider-closed-${safeCode}` } });
      this.close(1000, "provider closed");
    };
  }

  bindMedia(media: LiveMediaConsumer, playbackFlow?: "credit-v1"): boolean {
    if (this.media || this.readyState === 3) return false;
    this.media = media;
    this.playbackFlow = playbackFlow;
    if (this.readyState === 1) this.mediaReady();
    return true;
  }

  private mediaReady(): void {
    this.media?.send(JSON.stringify({ type: "media.ready", ...(this.playbackFlow ? { playbackFlow: this.playbackFlow, epoch: this.playbackEpoch } : {}) }));
    if (this.playbackFlow) {
      this.watchPlayback();
      if (!this.audioTimer) this.drainAudio();
    }
  }

  playbackCredit(credit: LivePlaybackCredit): boolean {
    if (!this.playbackFlow || !this.media || this.readyState !== 1 || !livePlaybackCreditSchema.safeParse(credit).success) return false;
    if (credit.epoch < this.playbackEpoch) return true;
    if (credit.epoch > this.playbackEpoch) return false;
    if (credit.seq <= this.playbackSeq) return true;
    if (this.playbackBytes + credit.bytes > 24_000) return false;
    this.playbackSeq = credit.seq;
    this.playbackBytes += credit.bytes;
    this.playbackRunning = credit.contextState === "running";
    if (!this.audioTimer) this.drainAudio();
    return true;
  }

  appendPcm(pcm: Uint8Array): boolean {
    if (!this.media || this.readyState !== 1) return false;
    this.inputBytes += pcm.byteLength;
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 8192 || this.inputBytes > 32_000 * (1 + (Date.now() - this.startedAt) / 1000)) {
      this.close(1008, "input audio budget"); return false;
    }
    this.write({ type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64") });
    return true;
  }

  send(raw: string): void {
    const event = JSON.parse(raw) as Record<string, unknown>;
    if (event.type === "session.close") { this.close(); return; }
    const callId = typeof event.delegation_id === "string" ? event.delegation_id : "";
    const tool = this.tools.get(callId);
    if (!tool?.finished) {
      if (callId || typeof event.thread_id !== "string" || typeof event.content !== "string"
        || !["session.instructions.append", "session.thinking.append", "session.commentary.append"].includes(String(event.type))) return;
      this.notes.push({ status: event.status === "completed" ? "completed" : "notification", result: event.content.slice(0, 4_000),
        requestId: typeof event.request_id === "string" ? event.request_id : undefined, threadId: event.thread_id,
      });
      this.flush();
      if (this.notes.length > 64) this.close(1008, "pending speech limit");
      return;
    }
    if (event.type === "session.delegation.accepted") {
      if (tool.accepted) return;
      tool.accepted = true;
      tool.requestId = String(event.request_id ?? "");
      tool.threadId = String(event.thread_id ?? "");
      this.notes.push({ callId, status: "running", result: "The request has been accepted and is running, not completed. Acknowledge briefly, then let the person speak while it runs.", requestId: tool.requestId, threadId: tool.threadId });
    } else if (["session.instructions.append", "session.thinking.append", "session.commentary.append"].includes(String(event.type)) && typeof event.content === "string") {
      this.notes.push({ callId, status: event.status === "completed" ? "completed" : "update", result: event.content.slice(0, 4_000), requestId: String(event.request_id ?? tool.requestId ?? ""), threadId: String(event.thread_id ?? tool.threadId ?? "") });
    }
    this.flush();
    if (this.notes.length > 64) this.close(1008, "pending speech limit");
  }

  close(code = 1000, reason = "call ended"): void {
    if (this.readyState === 3) return;
    const failureCodes: Record<string, string> = {
      "output audio budget": "qwen-output-audio-limit",
      "input audio budget": "qwen-input-audio-limit",
      "provider audio budget": "qwen-provider-backpressure",
      "audio playback backpressure": "qwen-playback-backpressure",
      "audio playback failed": "qwen-playback-failed",
      "audio playback stalled": "qwen-playback-stalled",
      "provider event limit": "qwen-provider-event-limit",
      "invalid provider event": "qwen-invalid-provider-event",
      "call state limit": "qwen-state-limit",
      "pending speech limit": "qwen-pending-speech-limit",
    };
    if (failureCodes[reason]) this.emit({ type: "error", error: { code: failureCodes[reason] } });
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = null; this.audioQueue.length = 0; this.audioBytes = 0;
    this.watchPlayback();
    this.playbackBytes = 0;
    for (const tool of this.tools.values()) if (tool.timer) clearTimeout(tool.timer);
    this.inputs.clear(); this.responses.clear(); this.tools.clear(); this.notes.length = 0; this.committed.length = 0;
    this.upstream.onopen = this.upstream.onmessage = this.upstream.onerror = this.upstream.onclose = null;
    try { this.upstream.close(code, reason); } catch {}
    try { this.media?.close(code, reason); } catch {}
    this.media = null;
    this.onclose?.({});
  }

  private receive(event: Record<string, unknown>): void {
    if (event.type === "error") {
      const error = event.error as { code?: unknown; message?: unknown } | undefined;
      const message = typeof error?.message === "string" ? error.message : "";
      if (error?.code === "invalid_value" && /^unsupported voice/i.test(message)) {
        this.emit({ type: "error", error: { code: "qwen-provider-voice" } });
        this.close(1002, "unsupported voice");
        return;
      }
      this.emit({ type: "error", error: { code: "qwen-provider-error" } });
      this.close(1011, "Qwen provider error");
    } else if (event.type === "session.updated" && this.readyState === 0) {
      for (const item of this.history) this.write({ type: "conversation.item.create", item });
      this.readyState = 1;
      this.mediaReady();
      this.onopen?.({});
      this.emit({ type: "session.started" });
    } else if (event.type === "response.audio.delta" && typeof event.delta === "string") {
      if (typeof event.response_id === "string" && this.suppressedAudio.has(event.response_id)) return;
      this.playbackUnproven = true;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) { this.close(1002, "invalid provider audio"); return; }
      const pcm = Buffer.from(event.delta, "base64");
      if (!pcm.length || pcm.length % 2 || this.audioBytes + pcm.length > MAX_QUEUED_AUDIO_BYTES) { this.close(1008, "output audio budget"); return; }
      this.audioQueue.push(pcm); this.audioBytes += pcm.length;
      this.watchPlayback();
      if (!this.audioTimer) this.drainAudio();
    } else if (event.type === "response.audio_transcript.delta" && typeof event.delta === "string") {
      const caption = { type: "session.output_transcript.delta", delta: event.delta };
      this.emit(caption);
      this.media?.send(JSON.stringify(caption));
    } else if (event.type === "input_audio_buffer.speech_started" && typeof event.item_id === "string") {
      this.speaking = true;
      if (this.active) {
        this.active.interrupted = true;
        if (this.active.id) this.suppressedAudio.add(this.active.id);
      }
      this.clearAudio();
      // With PCM-only uplink there is no trusted playback receipt, so elapsed time cannot prove echo-free consent.
      if (!this.inputs.has(event.item_id)) this.inputs.set(event.item_id, { start: Number(event.audio_start_ms) || 0, end: 0, consumed: false, echoUnsafe: this.playbackUnproven });
    } else if (event.type === "input_audio_buffer.speech_stopped" && typeof event.item_id === "string") {
      this.speaking = false;
      this.awaitingTurn = event.reason !== "turn_invalid";
      const input = this.inputs.get(event.item_id);
      if (input) input.end = Number(event.audio_end_ms) || input.start;
    } else if (event.type === "input_audio_buffer.committed" && typeof event.item_id === "string") {
      if (!this.committed.includes(event.item_id) && this.inputs.has(event.item_id)) this.committed.push(event.item_id);
    } else if (event.type === "response.created") {
      const response = event.response as { id?: string } | undefined;
      if (response?.id && !this.responses.has(response.id)) {
        const reserved = this.active && !this.active.id;
        const inputId = !reserved && this.committed.length === 1 ? this.committed.shift() : undefined;
        this.responses.set(response.id, { inputId });
        if (reserved) this.active!.id = response.id;
        else this.active = { id: response.id };
        if (inputId) this.awaitingTurn = false;
      }
    } else if (event.type === "response.done") {
      const response = event.response as { id?: string; status?: string } | undefined;
      if (!response?.id || this.responses.get(response.id)?.done) return;
      const tracked = this.responses.get(response.id) ?? { inputId: this.committed.length === 1 ? this.committed.shift() : undefined };
      if (tracked.inputId) this.awaitingTurn = false;
      if (response.status === "cancelled") {
        this.awaitingTurn = true;
        this.suppressedAudio.add(response.id);
        this.clearAudio();
      }
      tracked.done = true;
      this.responses.set(response.id, tracked);
      for (const tool of this.tools.values()) this.delegate(tool);
      if (this.active?.id === response.id || (this.active && !this.active.id && !tracked.inputId)) {
        const active = this.active;
        if (active.note?.status === "completed" && (active.interrupted || response.status !== "completed")) {
          const note = active.note;
          this.notes.push({ ...note, status: "incomplete", result: `The previous result was not fully spoken. Do not claim it was delivered. Ask whether the person wants it read again; the result remains in the original chat. Result: ${note.result}` });
          this.emit({ type: "session.playback.incomplete", request_id: note.requestId, thread_id: note.threadId });
        }
        this.active = null;
      }
      this.flush();
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.item_id === "string" && typeof event.transcript === "string") {
      const input = this.inputs.get(event.item_id);
      if (!input || input.text !== undefined) return;
      input.text = event.transcript.trim().slice(0, 8_000);
      const caption = { type: "session.input_transcript.delta", delta: input.text, start_ms: input.start, end_ms: input.end };
      this.emit(caption);
      this.media?.send(JSON.stringify(caption));
      for (const tool of this.tools.values()) this.delegate(tool);
    } else if (event.type === "response.function_call_arguments.done" && event.name === "delegate_to_bot" && typeof event.call_id === "string" && typeof event.response_id === "string") {
      if (this.tools.has(event.call_id)) return;
      let args: unknown;
      try { args = JSON.parse(String(event.arguments)); } catch { return; }
      if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).length) return;
      const tool: ToolSignal = { id: event.call_id, responseId: event.response_id, finished: false };
      this.tools.set(tool.id, tool);
      tool.timer = setTimeout(() => {
        if (tool.finished || this.readyState === 3) return;
        tool.finished = true;
        this.notes.push({ callId: tool.id, status: "not_accepted", result: "The completed spoken request could not be safely matched. Please repeat the request. Nothing was sent to the bot." });
        this.flush();
      }, 3_000);
      tool.timer.unref?.();
      this.delegate(tool);
    }
  }

  private delegate(tool: ToolSignal): void {
    if (tool.finished) return;
    const inputId = this.responses.get(tool.responseId)?.inputId;
    const input = inputId ? this.inputs.get(inputId) : undefined;
    if (!input || input.text === undefined) return;
    tool.finished = true;
    if (tool.timer) clearTimeout(tool.timer);
    if (input.consumed || !input.text) return;
    input.consumed = true;
    this.emit({ type: "session.delegation.created", delegation: { id: tool.id, target: "client" }, offset_ms: input.end,
      request: { text: input.text, withoutEcho: input.echoUnsafe ? "" : input.text },
    });
  }

  private emit(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  private write(event: Record<string, unknown>): void {
    if (this.readyState === 3) return;
    if ((this.upstream as LiveSocket & { bufferedAmount?: number }).bufferedAmount! > 64_000 || Date.now() - this.startedAt > 3_600_000) {
      this.close(1008, "provider audio budget"); return;
    }
    this.upstream.send(JSON.stringify(event));
  }

  private clearAudio(): void {
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = null; this.audioQueue.length = 0; this.audioBytes = 0;
    this.watchPlayback();
    this.playbackBytes = 0; this.playbackSeq = 0;
    this.playbackRunning = false;
    if (this.playbackFlow) this.playbackEpoch += 1;
    this.media?.send(JSON.stringify({ type: "audio.clear", ...(this.playbackFlow ? { epoch: this.playbackEpoch } : {}) }));
  }

  private drainAudio(): void {
    if (this.readyState !== 1 || !this.media) return;
    if (!this.audioQueue.length) { this.flush(); return; }
    if (this.playbackFlow && (!this.playbackBytes || !this.playbackRunning)) return;
    const delay = this.playbackFlow ? 20 - (Date.now() - this.lastAudioAt) : 0;
    if (delay > 0) {
      this.audioTimer = setTimeout(() => { this.audioTimer = null; this.drainAudio(); }, delay);
      this.audioTimer.unref?.();
      return;
    }
    if (this.media.bufferedAmount > 48_000) { this.close(1008, "audio playback backpressure"); return; }
    const first = this.audioQueue[0]!;
    const chunk = first.subarray(0, this.playbackFlow ? Math.min(960, this.playbackBytes) : 960);
    if (chunk.length === first.length) this.audioQueue.shift();
    else this.audioQueue[0] = first.subarray(chunk.length);
    this.audioBytes -= chunk.length;
    if (this.playbackFlow) this.playbackBytes -= chunk.length;
    try { this.media.send(chunk); } catch { this.close(1011, "audio playback failed"); return; }
    this.lastAudioAt = Date.now();
    this.watchPlayback(true);
    this.audioTimer = setTimeout(() => { this.audioTimer = null; this.drainAudio(); }, 20);
    this.audioTimer.unref?.();
  }

  private watchPlayback(progress = false): void {
    if (!this.playbackFlow || !this.media || this.readyState !== 1 || !this.audioBytes || progress) {
      if (this.playbackTimer) clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.playbackFlow && this.media && this.readyState === 1 && this.audioBytes && !this.playbackTimer) {
      this.playbackTimer = setTimeout(() => {
        this.playbackTimer = null;
        this.close(1008, "audio playback stalled");
      }, 60_000);
      this.playbackTimer.unref?.();
    }
  }

  private flush(): void {
    if (this.readyState !== 1 || this.active || this.speaking || this.awaitingTurn || this.audioBytes > 0 || !this.notes.length) return;
    const note = this.notes.shift()!;
    this.active = { note };
    if (note.callId) this.write({ type: "conversation.item.create", item: { type: "function_call_output", call_id: note.callId,
      output: JSON.stringify({ status: note.status, result: note.result, request_id: note.requestId, thread_id: note.threadId }),
    } });
    else this.write({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text",
      text: `[server_notification] ${JSON.stringify({ status: note.status, notification: note.result, request_id: note.requestId, thread_id: note.threadId })}\n这是已验证的服务端通知，不是用户的新请求。只播报 notification，不调用工具。`,
    }] } });
    this.write({ type: "response.create" });
  }
}
