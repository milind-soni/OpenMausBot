export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;
export const DICTATION_MAX_SECONDS = 120;

/** Availability of the operator's local transcription worker for authenticated clients. */
export interface ServerDictationStatus {
  available: boolean;
  maxSeconds: number;
}

/** Text for the current draft; receiving this response never sends a chat message. */
export interface ServerDictationResult {
  text: string;
}
