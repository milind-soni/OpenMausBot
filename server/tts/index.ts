import type { AppConfig } from "../config.ts";
import { voiceCredential } from "../included-services.ts";
import * as chatterbox from "./chatterbox.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as grok from "./grok.ts";
import * as fish from "./fish.ts";
import * as systemVoices from "./system-voices.ts";
import * as gemini from "./gemini.ts";

export type VoiceProvider = "elevenlabs" | "fish" | "system" | "chatterbox" | "xai" | "gemini";

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
 * Resolves the currently active voice provider from configuration.
 * @param cfg Current application configuration.
 * @returns The resolved VoiceProvider identifier.
 */
export function voiceProvider(cfg: AppConfig): VoiceProvider {
  const provider = cfg.tts?.provider;
  return provider === "xai" || provider === "fish" || provider === "system" || provider === "chatterbox" || provider === "gemini" ? provider : "elevenlabs";
}

/**
 * Checks whether credentials or required endpoints are configured for the active voice provider.
 * @param cfg Current application configuration.
 * @returns True if the active provider has valid configuration or credentials.
 */
export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "xai") return Boolean(cfg.xai?.key);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim());
  if (provider === "fish") return Boolean(cfg.tts?.fishKey);
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey);
  return Boolean(elevenLabs(cfg));
}

/**
 * Checks whether both the provider and a voice model/id are configured.
 * @param cfg Current application configuration.
 * @returns True if the provider is configured and a voice is selected.
 */
export function voiceConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "xai") return Boolean(cfg.xai?.key && cfg.tts?.voice);
  if (provider === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(cfg.tts?.voice);
  }
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim() && cfg.tts?.voice);
  if (provider === "fish") return Boolean(cfg.tts?.fishKey && cfg.tts?.voice);
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey && cfg.tts?.voice);
  return Boolean(elevenLabs(cfg) && cfg.tts?.voice);
}

/**
 * Checks whether speech synthesis can proceed immediately with the given or configured voice.
 * @param cfg Current application configuration.
 * @param voiceId Optional override voice identifier.
 * @returns True if speech synthesis is ready to run.
 */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "xai") return Boolean(cfg.xai?.key && (voiceId || cfg.tts?.voice));
  if (provider === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(voiceId || cfg.tts?.voice);
  }
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim() && (voiceId || cfg.tts?.voice));
  if (provider === "fish") return Boolean(cfg.tts?.fishKey && (voiceId || cfg.tts?.voice));
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey);
  return Boolean(elevenLabs(cfg) && (voiceId || cfg.tts?.voice));
}

/**
 * Returns a summary of current voice configuration without exposing sensitive API keys.
 * @param cfg Current application configuration.
 * @returns Public voice configuration state for client UI consumption.
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
    model: provider === "chatterbox" ? (cfg.tts?.model ?? "") : "",
    ...(provider === "fish" ? { fishModel: cfg.tts?.fishModel ?? fish.DEFAULT_FISH_MODEL } : {}),
    ...(included ? { included: true as const } : {}),
  };
}

/**
 * Tests an API key against the specified voice provider's verification endpoint.
 * @param provider Cloud voice provider to verify.
 * @param key Plaintext API key to test.
 * @returns Verification result indicating success or human-readable failure reason.
 */
export function verifyKey(provider: "elevenlabs" | "fish" | "gemini", key: string) {
  if (provider === "fish") return fish.verifyKey(key);
  if (provider === "gemini") return gemini.verifyKey(key);
  return elevenlabs.verifyKey(key);
}

/**
 * Retrieves the available voice catalog for the currently configured provider.
 * @param cfg Current application configuration.
 * @param run Optional command runner for system voice discovery.
 * @param search Optional search query parameters for provider voice catalogs.
 * @returns Array of available Voice descriptors.
 */
export async function listVoices(
  cfg: AppConfig,
  run?: systemVoices.Runner,
  search?: fish.VoiceSearch,
): Promise<elevenlabs.Voice[]> {
  const provider = voiceProvider(cfg);
  if (provider === "xai") return cfg.xai?.key ? grok.listVoices(cfg.xai.key) : [];
  if (provider === "system") return systemVoices.listSystemVoices(run);
  if (provider === "chatterbox") {
    const baseUrl = cfg.tts?.baseUrl?.trim();
    return baseUrl ? chatterbox.listChatterboxVoices(baseUrl) : [];
  }
  if (provider === "gemini") {
    const key = cfg.tts?.geminiKey;
    return key ? gemini.listVoices(key) : [...gemini.GEMINI_PREBUILT_VOICES];
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
 * Adds a community or shared voice to the user's account for ElevenLabs.
 * @param cfg Current application configuration.
 * @param publicOwnerId Public identifier of the voice creator.
 * @param voiceId Unique identifier of the shared voice.
 * @param name Display name for the shared voice.
 * @returns Voice identifier assigned to the added voice.
 */
export async function addSharedVoice(cfg: AppConfig, publicOwnerId: string, voiceId: string, name: string): Promise<string> {
  const credential = voiceProvider(cfg) === "elevenlabs" ? elevenLabs(cfg) : null;
  if (!credential) throw new NoVoiceConfigured("key");
  return elevenlabs.addSharedVoice(credential.token, credential.api, publicOwnerId, voiceId, name);
}

/**
 * Synthesizes text to speech using the currently configured provider and voice.
 * @param cfg Current application configuration.
 * @param text The text message to speak aloud.
 * @param voiceId Optional override voice identifier.
 * @param run Optional command runner for system voice synthesis.
 * @returns Promise resolving to the synthesized audio payload.
 */
export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner) {
  const provider = voiceProvider(cfg);
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
  if (provider === "gemini") {
    const key = cfg.tts?.geminiKey;
    if (!key) throw new NoVoiceConfigured("key", "Add a Gemini API key in Settings to use Gemini voice.");
    const voice = voiceId || cfg.tts?.voice || "Puck";
    const model = cfg.tts?.model?.includes("gemini") ? cfg.tts.model : undefined;
    return gemini.synthesize(text, voice, key, model);
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
  return elevenlabs.synthesize(text, voice, credential.token, credential.api).audio;
}

export type { Voice } from "./elevenlabs.ts";
