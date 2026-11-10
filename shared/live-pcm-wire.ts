export type LiveProvider = "openai" | "azure" | "qwen";
/** Qwen is an effective provider; persisted live.provider remains openai or azure for rollback compatibility. */
export interface LiveSettings extends Omit<import("./live-call-wire.ts").LiveSettings, "provider"> {
  provider?: LiveProvider;
  qwenRegion?: "cn-beijing" | "ap-southeast-1";
  qwenWorkspace?: string;
  qwenModel?: "qwen-audio-3.1-realtime-flash" | "qwen-audio-3.1-realtime-plus";
  qwenVoice?: string;
  qwenKeyConfigured?: boolean;
}
export type LiveSettingsPatch = Partial<Omit<LiveSettings, "configured" | "keySource" | "qwenKeyConfigured">>;
export interface LivePcmTransport {
  type: "ws-pcm";
  path: "/api/live/media";
  inputSampleRate: 16000;
  outputSampleRate: 24000;
  /** Optional bounded playback flow, activated only by an explicit media bind opt-in. */
  playbackFlow?: "credit-v1";
}

export type LiveAudioContextState = "running" | "suspended" | "interrupted" | "closed";
/** Untrusted local playback capacity, never proof of hearing or authority to approve a card. */
export interface LivePlaybackCredit {
  type: "playback.credit";
  epoch: number;
  seq: number;
  bytes: number;
  contextState: LiveAudioContextState;
}

export type LiveClientFailureCode = "upload-backpressure" | "capture-stale" | "capture-overrun" | "playback-buffer" | "playback-stalled" | "audio-context" | "media-socket" | "media-protocol" | "media-processor";
/** Bounded, untrusted client diagnostics; never a provider error or permission instruction. */
export interface LiveClientFailure {
  type: "client.failure";
  code: LiveClientFailureCode;
  contextState: LiveAudioContextState;
  bufferedBytes: number;
  queuedMs: number;
  frameAgeMs: number;
}
