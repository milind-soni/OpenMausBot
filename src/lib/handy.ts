// The wake word's transcription engine. "cloud" is the built-in Deepgram
// bridge (needs a key); "handy" drives the user's own Handy app
// (https://handy.computer) — offline Whisper on this machine, triggered by
// the same Ctrl+Space-style gesture the user already knows, only spoken
// instead of pressed.
//
// The Handy executable path is stored (never the transcript flow — Handy
// owns everything about recording and decoding). Only the toggle IPC and
// the clipboard are ours.

export type WakeDictationEngine = "cloud" | "handy";

const STORAGE_KEY = "openmausbot.wake-engine.v1";
const HANDY_PATH_KEY = "openmausbot.handy-path.v1";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function wakeDictationEngine(): WakeDictationEngine {
  return storage()?.getItem(STORAGE_KEY) === "handy" ? "handy" : "cloud";
}

export function setWakeDictationEngine(engine: WakeDictationEngine): void {
  try {
    storage()?.setItem(STORAGE_KEY, engine);
  } catch {
    // A locked-down renderer may reject storage; the choice then just
    // doesn't persist. Not a prerequisite for a working session.
  }
}

/** Where Handy's executable lives; empty means "try PATH". */
export function handyPath(): string {
  return storage()?.getItem(HANDY_PATH_KEY) ?? "";
}

export function setHandyPath(path: string): void {
  try {
    storage()?.setItem(HANDY_PATH_KEY, path);
  } catch {}
}
