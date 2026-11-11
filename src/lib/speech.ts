import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { recordedSpeech, type SpeechBridge } from "./recorded-speech";
import { isEndpointStt } from "../../shared/stt";

/** Automatic keeps the desktop's own recognizer; Fish Audio, an explicit provider, or a page without one records the microphone itself. */
export function usesRecordedSpeech(config?: ConfigStatus | null, capabilities = desktopCapabilitiesNow()): boolean {
  return (config?.stt?.provider ?? "auto") !== "auto" || capabilities.dictation.engine === "fish-audio" || !capabilities.dictation.available;
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

/** The desktop app reports whether it can listen; a browser page can record only on a secure origin. */
function recordsHere(capabilities: DesktopCapabilities): boolean {
  return capabilities.dictation.available || pageCanRecord();
}

/** Who turns speech into text here: the Mac's own recognizer, Fish Audio, or a configured transcription server. */
export function speechRecognizer(config: ConfigStatus | null | undefined, capabilities: DesktopCapabilities): "native" | "fish" | "endpoint" {
  if (!usesRecordedSpeech(config, capabilities)) return "native";
  return isEndpointStt(config?.stt?.provider) ? "endpoint" : "fish";
}

/** Whether this device can hear the person at all, before asking whether a transcription service is set up. */
export function canListenHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return usesRecordedSpeech(config, capabilities) ? recordsHere(capabilities) : capabilities.dictation.available;
}

export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return canListenHere(capabilities, config) && (!usesRecordedSpeech(config, capabilities) || serverListeningReady(config));
}

export function stopSpeech() {
  void recordedSpeech.speechStop();
  void globalThis.window?.ogb?.speechStop?.();
}
