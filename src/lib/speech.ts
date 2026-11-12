import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";

/** Quiet after speech that ends the person's turn in a call, through the Mac's helper or Fish Audio alike: long enough
 * for a short thinking pause mid-sentence. */
export const CALL_ENDPOINT_MS = 1_700;

/** The speech bridge this computer listens through: the page's own Fish Audio listener, or the desktop app's helper. */
export function speechBridge(): SpeechBridge | Window["ogb"] {
  return desktopCapabilitiesNow().dictation.engine === "fish-audio" ? fishSpeech : globalThis.window?.ogb;
}

export function fishListeningReady(config: ConfigStatus | null | undefined): boolean {
  return savedState(keyEntry("fishAudio"), config).configured;
}

/** Whether speech can be heard here: the engine is there and, through Fish Audio, so is a saved key. */
export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return capabilities.dictation.available && (capabilities.dictation.engine !== "fish-audio" || fishListeningReady(config));
}
