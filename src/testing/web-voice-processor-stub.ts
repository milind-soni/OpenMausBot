// Test-only resolution target for @picovoice/web-voice-processor — see
// porcupine-web-stub.ts for the reasoning.

export const WebVoiceProcessor = {
  subscribe(): Promise<void> {
    return Promise.reject(new Error("@picovoice/web-voice-processor stub used outside vi.mock"));
  },
  unsubscribe(): Promise<void> {
    return Promise.reject(new Error("@picovoice/web-voice-processor stub used outside vi.mock"));
  },
};
