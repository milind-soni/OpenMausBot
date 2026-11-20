import { DEEPSEEK_RECORDING_MAX_MS } from "../../shared/deepseek-voice";
import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";

/** Quiet after speech that ends the person's turn in a call, through the Mac's helper or Fish Audio alike: long enough
 * for a short thinking pause mid-sentence. */
export const CALL_ENDPOINT_MS = 1_700;

const deepseekSpeech: SpeechBridge = {
  ...fishSpeech,
  speechStart: (options) => fishSpeech.speechStart({ ...options, maxMs: DEEPSEEK_RECORDING_MAX_MS }),
};

/** DeepSeek voice also hears through DeepSeek, on every computer that can listen at all. */
const deepseekHears = (config: ConfigStatus | null | undefined) => config?.tts?.provider === "deepseek";

function serverHears(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return capabilities.dictation.engine === "fish-audio" || (capabilities.dictation.available && deepseekHears(config));
}

/** The speech bridge this computer listens through: the page's own recorder (heard by the harness through DeepSeek,
 * Fish Audio or ElevenLabs), or the desktop app's helper. */
export function speechBridge(config: ConfigStatus | null | undefined): SpeechBridge | Window["ogb"] {
  const capabilities = desktopCapabilitiesNow();
  if (capabilities.dictation.available && deepseekHears(config)) return deepseekSpeech;
  return capabilities.dictation.engine === "fish-audio" ? fishSpeech : globalThis.window?.ogb;
}

/** The page's recorder hears a clip only at its end, so stopping the mic must finish it. */
export const recordsClips = (bridge: SpeechBridge | Window["ogb"]) => bridge === fishSpeech || bridge === deepseekSpeech;

/** Stops whichever bridge is listening, for a caller that cannot know which one started. */
export function stopListening(): void {
  void fishSpeech.speechStop();
  void globalThis.window?.ogb?.speechStop?.();
}

/** A key the server listens with: DeepSeek while it is the voice; otherwise Fish Audio, or the person's own
 * ElevenLabs key (not the plan's included voice). */
export function fishListeningReady(config: ConfigStatus | null | undefined): boolean {
  if (deepseekHears(config)) return savedState(keyEntry("deepseek"), config).configured;
  if (savedState(keyEntry("fishAudio"), config).configured) return true;
  const eleven = savedState(keyEntry("elevenlabs"), config);
  return eleven.configured && !eleven.included;
}

/** The key this computer still needs before the server can hear it, if any. */
export function missingListenKey(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): "fish" | "deepseek" | null {
  if (!serverHears(capabilities, config) || fishListeningReady(config)) return null;
  return deepseekHears(config) ? "deepseek" : "fish";
}

/** Whether speech can be heard here: the engine is there and, through the server, so is a saved key. */
export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return capabilities.dictation.available && missingListenKey(capabilities, config) === null;
}
