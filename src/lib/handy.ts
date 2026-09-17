// The wake word's transcription engine: the user's own Handy app
// (https://handy.computer) — offline Whisper on this machine, triggered by the
// same Ctrl+Space-style gesture the user already knows, only spoken instead of
// pressed.
//
// There is no cloud engine to choose between any more, so the only thing that
// needs remembering here is where Handy lives. Astra captures audio; Handy owns
// decoding. We only need its executable.

const HANDY_PATH_KEY = "astra.handy-path.v1";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Where Handy's executable lives; empty means "try its default install
 * locations, then PATH". */
export function handyPath(): string {
  return storage()?.getItem(HANDY_PATH_KEY) ?? "";
}

export function setHandyPath(path: string): void {
  try {
    storage()?.setItem(HANDY_PATH_KEY, path);
  } catch {}
}
