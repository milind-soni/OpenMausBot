// Voice, wired to config. Two engines live behind this file: ElevenLabs
// (elevenlabs.ts, needs a key) and the Mac's built-in voices
// (system-voices.ts, no key). This file is only the part that reads
// ~/.astra/config.json, picks the engine, and decides whether there
// is a voice at all.
import type { AppConfig } from "../config.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as systemVoices from "./system-voices.ts";
import * as windowsVoices from "./windows-voices.ts";
import * as piper from "./piper.ts";
import * as piperInstall from "./piper-install.ts";

export type VoiceProvider = "elevenlabs" | "system" | "piper";

export class NoVoiceConfigured extends Error {
  // a plain field rather than a constructor parameter property: the harness
  // runs under `node --experimental-strip-types`, which is strip-ONLY, so a
  // parameter property is rejected at load time even though it typechecks
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice", message?: string) {
    super(
      message ??
        (reason === "key"
          ? "Add an ElevenLabs key in Settings on the computer to turn on voice."
          : "Pick a voice in the agent profile."),
    );
    this.reason = reason;
  }
}

/** The provider the user SELECTED, availability aside — every consumer
 * gates on its own engine check, so a picked-but-unprovisioned Piper
 * reports itself honestly instead of masquerading as ElevenLabs and
 * producing “add an ElevenLabs key” advice. */
export function voiceProvider(cfg: AppConfig): VoiceProvider {
  if (cfg.tts?.provider === "piper") return "piper";
  return cfg.tts?.provider === "system" ? "system" : "elevenlabs";
}

/** The platform's built-in voice engine: `say` on macOS, SAPI via
 * PowerShell on Windows. The system provider needs no credential — it is
 * only ever offered where the platform actually has it, so "configured"
 * means "this engine can speak", not "a key is on file". */
export function platformVoicesAvailable(platform: string = process.platform): boolean {
  return systemVoices.systemVoicesAvailable(platform) || windowsVoices.windowsVoicesAvailable(platform);
}

export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") return platformVoicesAvailable();
  if (provider === "piper") return piper.piperAvailable();
  return Boolean(cfg.tts?.key);
}

export function voiceConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") {
    return platformVoicesAvailable() && Boolean(cfg.tts?.voice);
  }
  if (provider === "piper") {
    return piper.piperAvailable() && Boolean(piper.listPiperVoices().length) && Boolean(cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && cfg.tts?.voice);
}

/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") {
    return platformVoicesAvailable() && Boolean(voiceId || cfg.tts?.voice);
  }
  if (provider === "piper") {
    return piper.piperAvailable() && Boolean(piper.listPiperVoices().length) && Boolean(voiceId || cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && (voiceId || cfg.tts?.voice));
}

/** What the settings panel needs. Never includes the key — same write-only
 * rule as every other credential. */
export function describeVoice(cfg: AppConfig) {
  const install = piperInstall.piperInstallState();
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice ?? "",
    provider: voiceProvider(cfg),
    piperAvailable: piper.piperAvailable(),
    /** So Settings can offer the one-click install instead of only pointing at
     * the docs, and can say why the offer is absent on this platform. */
    piperInstallable: piperInstall.piperInstallable(piperInstall.piperTarget()),
    piperInstalling: install.installing,
    piperInstallError: install.error,
  };
}

export function verifyKey(key: string) {
  return elevenlabs.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner): Promise<elevenlabs.Voice[]> {
  if (voiceProvider(cfg) === "piper") return piper.listPiperVoices();
  if (voiceProvider(cfg) === "system") {
    // The injected runner is the say-shaped test seam; production routes by
    // platform: win32 → SAPI via PowerShell, everything else → `say`.
    if (run) return systemVoices.listSystemVoices(run);
    if (windowsVoices.windowsVoicesAvailable()) return windowsVoices.listWindowsVoices();
    return systemVoices.listSystemVoices();
  }
  const key = cfg.tts?.key;
  if (!key) return [];
  return elevenlabs.listVoices(key);
}

/** Synthesize one utterance. Throws NoVoiceConfigured when there is nothing
 * to speak with, which the route turns into a 409 the client can explain. */
export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner) {
  if (voiceProvider(cfg) === "piper") {
    const voice = voiceId || cfg.tts?.voice;
    if (!piper.piperAvailable()) {
      throw new NoVoiceConfigured(
        "key",
        "The Piper engine is not on this computer yet — add it once to ~/.astra/piper (see the voice docs).",
      );
    }
    if (!voice) {
      throw new NoVoiceConfigured(
        "voice",
        "Pick a Piper voice in Settings → Voice & Handy.",
      );
    }
    return piper.synthesizePiper(text, voice);
  }
  if (voiceProvider(cfg) === "system") {
    const voice = voiceId || cfg.tts?.voice;
    // An injected runner is the cross-platform test seam, and it mimics
    // `say`; tests that exercise the PowerShell engine call
    // windows-voices.ts directly. Production calls omit the runner and are
    // strictly platform-gated: win32 → SAPI, everything else → `say`.
    if (!platformVoicesAvailable() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    if (run) return systemVoices.synthesizeSystem(text, voice, run);
    if (windowsVoices.windowsVoicesAvailable()) return windowsVoices.synthesizeWindows(text, voice);
    return systemVoices.synthesizeSystem(text, voice);
  }
  const key = cfg.tts?.key;
  if (!key) throw new NoVoiceConfigured("key");
  const voice = voiceId || cfg.tts?.voice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return elevenlabs.synthesize(text, voice, key);
}

export type { Voice } from "./elevenlabs.ts";
