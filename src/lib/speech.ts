import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { recordedSpeech, type SpeechBridge } from "./recorded-speech";

/** The page records the microphone itself unless Automatic can hand listening to Apple Speech in the Mac app. */
export function usesRecordedSpeech(config?: ConfigStatus | null, capabilities = desktopCapabilitiesNow()): boolean {
  return (config?.stt?.provider ?? "auto") !== "auto" || capabilities.dictation.engine !== "apple-speech";
}

export function speechBridge(config?: ConfigStatus | null, capabilities = desktopCapabilitiesNow()): SpeechBridge | Window["ogb"] {
  return usesRecordedSpeech(config, capabilities) ? recordedSpeech : globalThis.window?.ogb;
}

export function serverListeningReady(config: ConfigStatus | null | undefined): boolean {
  if (config?.stt) return config.stt.configured;
  return savedState(keyEntry("fishAudio"), config).configured;
}

/** Browsers expose the microphone only to secure pages: https, localhost or the desktop app. */
export function pageCanRecord(): boolean {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);
}

export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return usesRecordedSpeech(config, capabilities) ? pageCanRecord() && serverListeningReady(config) : capabilities.dictation.available;
}

export function stopSpeech() {
  void recordedSpeech.speechStop();
  void globalThis.window?.ogb?.speechStop?.();
}
