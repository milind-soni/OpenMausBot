export const TRANSCRIPTION_STATUS_EVENT = "openmausbot:transcription-status";

declare global {
  interface WindowEventMap {
    "openmausbot:transcription-status": CustomEvent<{ configured: boolean }>;
  }
}

export function announceTranscriptionStatus(configured: boolean) {
  window.dispatchEvent(new CustomEvent(TRANSCRIPTION_STATUS_EVENT, { detail: { configured } }));
}
