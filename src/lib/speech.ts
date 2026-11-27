import { DEEPSEEK_RECORDING_MAX_MS } from "../../shared/deepseek-voice";
import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { LocaleKey } from "@/locales";
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

/** The person's own ElevenLabs key is saved (not the plan's included voice). */
export function ownElevenLabsKey(config: ConfigStatus | null | undefined): boolean {
  const eleven = savedState(keyEntry("elevenlabs"), config);
  return eleven.configured && !eleven.included;
}

/** The person chose to be heard through their own ElevenLabs key (Scribe), on every computer, the Mac included. */
export const scribeChosen = (config: ConfigStatus | null | undefined) =>
  config?.tts?.hearWith === "elevenlabs" && ownElevenLabsKey(config);

/** Windows hears for free on the computer, until the person saves a key the server can hear with: then that key, as
 * before Windows had its own helper. */
const windowsKeyHears = (capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined) =>
  capabilities.dictation.engine === "windows-speech" && fishListeningReady(config);

/** The page records and the server hears, rather than the desktop app's own helper. */
export const pageRecords = (capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined) =>
  capabilities.dictation.engine === "fish-audio" || windowsKeyHears(capabilities, config);

function serverHears(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return pageRecords(capabilities, config)
    || (capabilities.dictation.available && (deepseekHears(config) || scribeChosen(config)));
}

/** The speech bridge this computer listens through: the page's own recorder (heard by the harness through DeepSeek,
 * Fish Audio or ElevenLabs), or the desktop app's helper. */
export function speechBridge(config: ConfigStatus | null | undefined): SpeechBridge | Window["ogb"] {
  const capabilities = desktopCapabilitiesNow();
  if (capabilities.dictation.available && scribeChosen(config)) return fishSpeech;
  if (capabilities.dictation.available && deepseekHears(config)) return deepseekSpeech;
  return pageRecords(capabilities, config) ? fishSpeech : globalThis.window?.ogb;
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
  if (scribeChosen(config)) return true;
  if (deepseekHears(config)) return savedState(keyEntry("deepseek"), config).configured;
  if (savedState(keyEntry("fishAudio"), config).configured) return true;
  return ownElevenLabsKey(config);
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

/** The note a call shows when the desktop helper stops listening with an error. A call has no text field, so a
 * missing recognizer points only to a key the server hears with, not to Windows voice typing. */
export function callSpeechEndNote(reason: string | undefined): LocaleKey {
  switch (reason) {
    case "helper-build-failed": return "call.turns.helperBuildFailed";
    case "dictation-disabled": return "composer.dictation.disabled";
    case "speech-not-authorized": return "call.turns.speechNotAuthorized";
    case "speech-language-missing": return "call.turns.languageMissing";
    default: return "composer.dictation.failed";
  }
}
