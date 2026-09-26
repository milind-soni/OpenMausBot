// Speech-to-text for calls and dictation on platforms without Apple's
// on-device recognizer (Windows, Linux). macOS keeps the native Swift helper;
// nothing here is consulted there unless the renderer explicitly routes to it.
//
// Off by default: sending microphone audio to a cloud service is an explicit
// choice, so an xAI key that already exists for chat or TTS does NOT turn
// recognition on by itself. The user picks a provider in Settings.
import type { AppConfig } from "../config.ts";
import { openAiCompatible } from "./openai-compatible.ts";
import type { SttProvider, SttProviderId, Transcript, Utterance } from "./types.ts";
import { xaiStt } from "./xai.ts";

export type { SttProviderId, Transcript, Utterance } from "./types.ts";
export { InvalidAudio, MAX_WAV_BYTES, MIN_UTTERANCE_MS, parseUtteranceWav } from "./wav.ts";

export const DEFAULT_MODELS: Record<SttProviderId, string> = {
  openai: "gpt-4o-mini-transcribe",
  groq: "whisper-large-v3-turbo",
  xai: "",
  local: "whisper-1",
};

const OPENAI_API = (process.env.OMB_OPENAI_STT_API || "https://api.openai.com/v1").replace(/\/+$/, "");
const GROQ_API = (process.env.OMB_GROQ_STT_API || "https://api.groq.com/openai/v1").replace(/\/+$/, "");

export class NoSttConfigured extends Error {
  readonly reason: "provider" | "key" | "server";

  constructor(reason: "provider" | "key" | "server", message: string) {
    super(message);
    this.reason = reason;
  }
}

export function sttProvider(cfg: AppConfig): SttProviderId | null {
  const provider = cfg.stt?.provider;
  return provider === "openai" || provider === "groq" || provider === "xai" || provider === "local" ? provider : null;
}

export function sttReady(cfg: AppConfig): boolean {
  switch (sttProvider(cfg)) {
    case "openai":
      return Boolean(cfg.stt?.openaiKey);
    case "groq":
      return Boolean(cfg.stt?.groqKey);
    case "xai":
      return Boolean(cfg.xai?.key);
    case "local":
      return Boolean(cfg.stt?.baseUrl?.trim());
    default:
      return false;
  }
}

/** What Settings and the call button need. Keys are reported as booleans
 * only; baseUrl/model/language are settings, not secrets. */
export function describeStt(cfg: AppConfig) {
  const provider = sttProvider(cfg);
  return {
    provider: provider ?? "",
    ready: sttReady(cfg),
    openaiConfigured: Boolean(cfg.stt?.openaiKey),
    groqConfigured: Boolean(cfg.stt?.groqKey),
    xaiConfigured: Boolean(cfg.xai?.key),
    baseUrl: cfg.stt?.baseUrl ?? "",
    model: cfg.stt?.model ?? "",
    language: cfg.stt?.language ?? "",
    // Interim (partial) transcripts re-send the growing utterance about once
    // a second. Free on a local server, a real cost on a billed API, so the
    // renderer only does it when the harness says it is local.
    interim: provider === "local",
  };
}

function resolveProvider(cfg: AppConfig): SttProvider {
  const provider = sttProvider(cfg);
  const model = cfg.stt?.model?.trim();
  switch (provider) {
    case "openai": {
      const key = cfg.stt?.openaiKey;
      if (!key) throw new NoSttConfigured("key", "Add an OpenAI key for speech recognition in Settings.");
      return openAiCompatible({ id: "openai", label: "OpenAI", baseUrl: OPENAI_API, key, model: model || DEFAULT_MODELS.openai, timeoutMs: 20_000 });
    }
    case "groq": {
      const key = cfg.stt?.groqKey;
      if (!key) throw new NoSttConfigured("key", "Add a Groq key for speech recognition in Settings.");
      return openAiCompatible({ id: "groq", label: "Groq", baseUrl: GROQ_API, key, model: model || DEFAULT_MODELS.groq, timeoutMs: 15_000 });
    }
    case "xai": {
      const key = cfg.xai?.key;
      if (!key) throw new NoSttConfigured("key", "Add an xAI key in Settings to use Grok speech recognition.");
      return xaiStt(key);
    }
    case "local": {
      const baseUrl = cfg.stt?.baseUrl?.trim();
      if (!baseUrl) throw new NoSttConfigured("server", "Add the address of your local speech server in Settings.");
      // CPU whisper on a long utterance can take a while; be patient locally.
      return openAiCompatible({ id: "local", label: "Local speech server", baseUrl, model: model || DEFAULT_MODELS.local, timeoutMs: 60_000 });
    }
    default:
      throw new NoSttConfigured("provider", "Choose a speech recognition provider in Settings to make calls on this computer.");
  }
}

/** Why recognition cannot run right now, or null when it can. The route
 * answers this before reading any audio. */
export function sttSetupProblem(cfg: AppConfig): NoSttConfigured | null {
  try {
    resolveProvider(cfg);
    return null;
  } catch (error) {
    if (error instanceof NoSttConfigured) return error;
    throw error;
  }
}

/** Transcribe one validated utterance with the configured provider. */
export function transcribe(
  cfg: AppConfig,
  utterance: Utterance,
  options: { signal?: AbortSignal } = {},
): Promise<Transcript> {
  const provider = resolveProvider(cfg);
  const language = cfg.stt?.language?.trim() || undefined;
  return provider.transcribe(utterance, { language, signal: options.signal });
}
