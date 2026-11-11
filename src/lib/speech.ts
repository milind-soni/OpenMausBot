import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";

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
