import type { AppConfig } from "../config.ts";
import { voiceCredential } from "../included-services.ts";
import * as chatterbox from "./chatterbox.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as openai from "./openai.ts";
import * as grok from "./grok.ts";
import * as fish from "./fish.ts";
import * as gemini from "./gemini.ts";
import * as systemVoices from "./system-voices.ts";

export type VoiceProvider = "elevenlabs" | "fish" | "system" | "chatterbox" | "xai" | "gemini" | "openai";

export class NoVoiceConfigured extends Error {
  // Not a parameter property: the harness runs under strip-only `node --experimental-strip-types`, which rejects one at load.
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice", hint?: string) {
    super(
      hint ??
        (reason === "key"
          ? "Add an ElevenLabs key in Settings on the computer to turn on voice."
          : "Pick a voice in the agent profile."),
    );
    this.reason = reason;
  }
}

const elevenLabs = (cfg: AppConfig) => voiceCredential(cfg.tts?.key);

/**
 * Resolves the active voice synthesis provider from configuration.
 * @param cfg The application configuration.
 * @returns The resolved VoiceProvider name.
 */
export function voiceProvider(cfg: AppConfig): VoiceProvider {
  const provider = cfg.tts?.provider;
  return provider === "gemini" || provider === "openai" || provider === "xai" || provider === "fish" || provider === "system" || provider === "chatterbox" ? provider : "elevenlabs";
}

/**
 * Determines whether the credentials or requirements for the active voice provider are met.
 * @param cfg The application configuration.
 * @returns True if provider requirements are configured.
 */
export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey);
  if (provider === "openai") return Boolean(cfg.openai?.key);
  if (provider === "xai") return Boolean(cfg.xai?.key);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim());
  if (provider === "fish") return Boolean(cfg.tts?.fishKey);
  return Boolean(elevenLabs(cfg));
}

/**
 * Determines whether the active voice provider is fully configured with a valid voice selection.
 * @param cfg The application configuration.
 * @returns True if provider has both key and configured voice.
 */
export function voiceConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey && gemini.isSupportedVoice(cfg.tts?.voice));
  if (provider === "openai") return Boolean(cfg.openai?.key && cfg.tts?.voice);
  if (provider === "xai") return Boolean(cfg.xai?.key && cfg.tts?.voice);
  if (provider === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(cfg.tts?.voice);
  }
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim() && cfg.tts?.voice);
  if (provider === "fish") return Boolean(cfg.tts?.fishKey && cfg.tts?.voice);
  return Boolean(elevenLabs(cfg) && cfg.tts?.voice);
}

/**
 * Checks whether voice synthesis is ready to execute with an optional override voice.
 * @param cfg The application configuration.
 * @param voiceId Optional override voice ID.
 * @returns True if ready to synthesize speech.
 */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey && gemini.isSupportedVoice(voiceId || cfg.tts?.voice));
  if (provider === "openai") return Boolean(cfg.openai?.key && (voiceId || cfg.tts?.voice));
  if (provider === "xai") return Boolean(cfg.xai?.key && (voiceId || cfg.tts?.voice));
  if (provider === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(voiceId || cfg.tts?.voice);
  }
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim() && (voiceId || cfg.tts?.voice));
  if (provider === "fish") return Boolean(cfg.tts?.fishKey && (voiceId || cfg.tts?.voice));
  return Boolean(elevenLabs(cfg) && (voiceId || cfg.tts?.voice));
}

/**
 * Returns a redacted voice configuration descriptor for status and UI display. Never includes the key.
 * @param cfg The application configuration.
 * @returns An object describing the current voice configuration status.
 */
export function describeVoice(cfg: AppConfig) {
  const provider = voiceProvider(cfg);
  const included = provider === "elevenlabs" && elevenLabs(cfg)?.included === true;
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice ?? "",
    provider,
    baseUrl: provider === "chatterbox" ? (cfg.tts?.baseUrl ?? "") : "",
    model: provider === "gemini" ? (cfg.tts?.model || gemini.DEFAULT_GEMINI_MODEL) : provider === "chatterbox" ? (cfg.tts?.model ?? "") : "",
    ...(provider === "fish" ? { fishModel: cfg.tts?.fishModel ?? fish.DEFAULT_FISH_MODEL } : {}),
    ...(included ? { included: true as const } : {}),
    ...(cfg.tts?.everyReply ? { everyReply: true as const } : {}),
  };
}

/**
 * Verifies an API key with the corresponding speech provider before saving.
 * @param provider The TTS provider name ("elevenlabs" | "fish" | "gemini").
 * @param key The API key to test.
 * @returns Result indicating whether the key is valid.
 */
export function verifyKey(provider: "elevenlabs" | "fish" | "gemini", key: string) {
  if (provider === "fish") return fish.verifyKey(key);
  if (provider === "gemini") return gemini.verifyKey(key);
  return elevenlabs.verifyKey(key);
}

/**
 * Lists voices available for the configured TTS provider.
 * @param cfg The application configuration.
 * @param run Optional system runner for native system voices.
 * @param search Optional fish voice search filter.
 * @returns Array of available Voice descriptors.
 */
export async function listVoices(
  cfg: AppConfig,
  run?: systemVoices.Runner,
  search?: fish.VoiceSearch,
): Promise<elevenlabs.Voice[]> {
  const provider = voiceProvider(cfg);
  if (provider === "gemini") return cfg.tts?.geminiKey ? gemini.listVoices() : [];
  if (provider === "openai") return cfg.openai?.key ? openai.listVoices() : [];
  if (provider === "xai") return cfg.xai?.key ? grok.listVoices(cfg.xai.key) : [];
  if (provider === "system") return systemVoices.listSystemVoices(run);
  if (provider === "chatterbox") {
    const baseUrl = cfg.tts?.baseUrl?.trim();
    return baseUrl ? chatterbox.listChatterboxVoices(baseUrl) : [];
  }
  if (provider === "fish") {
    const key = cfg.tts?.fishKey;
    return key ? fish.listVoices(key, search) : [];
  }
  const credential = elevenLabs(cfg);
  if (!credential) return [];
  return elevenlabs.listVoices(credential.token, credential.api, search);
}

/**
 * Adds a shared community voice from the Voice Library to the user's account.
 * @param cfg The application configuration.
 * @param publicOwnerId Public owner ID of the shared voice.
 * @param voiceId ID of the shared voice to add.
 * @param name Display name for the added voice.
 * @returns Added voice ID.
 */
export async function addSharedVoice(cfg: AppConfig, publicOwnerId: string, voiceId: string, name: string): Promise<string> {
  const credential = voiceProvider(cfg) === "elevenlabs" ? elevenLabs(cfg) : null;
  if (!credential) throw new NoVoiceConfigured("key");
  return elevenlabs.addSharedVoice(credential.token, credential.api, publicOwnerId, voiceId, name);
}

/**
 * Synthesizes text to speech using the currently configured provider.
 * @param cfg The application configuration.
 * @param text The plain text to synthesize into spoken audio.
 * @param voiceId Optional override voice ID.
 * @param run Optional runner for system voices.
 * @returns Synthesized audio buffer or stream promise.
 */
export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner, signal?: AbortSignal) {
  const provider = voiceProvider(cfg);
  if (provider === "gemini") {
    const key = cfg.tts?.geminiKey;
    if (!key) throw new NoVoiceConfigured("key", "Add a Gemini API key in Settings to use Gemini voice.");
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return gemini.synthesize(text, voice, key, cfg.tts?.model);
  }
  if (provider === "openai") return openai.synthesize(text, voiceId || cfg.tts?.voice || "", cfg.openai?.key || "", signal);
  if (provider === "xai") {
    const key = cfg.xai?.key;
    if (!key) throw new NoVoiceConfigured("key", "Add an xAI key in Settings to use Grok voice.");
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return grok.synthesize(text, voice, key);
  }
  if (provider === "system") {
    const voice = voiceId || cfg.tts?.voice;
    if (!systemVoices.systemVoicesAvailable() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    return systemVoices.synthesizeSystem(text, voice, run);
  }
  if (provider === "chatterbox") {
    const baseUrl = cfg.tts?.baseUrl?.trim();
    if (!baseUrl) {
      throw new NoVoiceConfigured(
        "key",
        "Add the address of your Chatterbox server in Settings on the computer to turn on voice.",
      );
    }
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return chatterbox.synthesizeChatterbox(text, voice, baseUrl, cfg.tts?.model);
  }
  if (provider === "fish") {
    const key = cfg.tts?.fishKey;
    if (!key) {
      throw new NoVoiceConfigured(
        "key",
        "Add a Fish Audio key in Settings on the computer to turn on voice.",
      );
    }
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return fish.synthesize(text, voice, key, cfg.tts?.fishModel);
  }
  const credential = elevenLabs(cfg);
  if (!credential) throw new NoVoiceConfigured("key");
  const voice = voiceId || cfg.tts?.voice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return elevenlabs.synthesize(text, voice, credential.token, credential.api, credential.included).audio;
}

export type { Voice } from "./elevenlabs.ts";
