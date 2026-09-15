// Test-only resolution target for @picovoice/porcupine-web (see the
// test.alias entry in vite.config.ts): the real package's entry point is
// browser-wasm and cannot be resolved under Node. Tests that need behavior
// vi.mock this specifier; these throwing defaults keep accidental engine
// use loud instead of silently inert.

export type PorcupineKeyword = {
  builtin?: string;
  label?: string;
  customWritePath?: string;
  sensitivity?: number;
};

export const Porcupine = {
  trainWakeWordFromPhrase(): Promise<never> {
    return Promise.reject(new Error("@picovoice/porcupine-web stub used outside vi.mock"));
  },
};

export const PorcupineWorker = {
  create(): Promise<never> {
    return Promise.reject(new Error("@picovoice/porcupine-web stub used outside vi.mock"));
  },
};
