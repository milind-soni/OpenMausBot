// The wake word's transcription engine: the user's own Handy app
// (https://handy.computer) — offline Whisper on this machine, triggered by the
// same Ctrl+Space-style gesture the user already knows, only spoken instead of
// pressed.
//
// There is no cloud engine to choose between any more, so the only thing that
// needs remembering here is where Handy lives, and — optionally — which model
// Astra's own calls should pin. Astra captures audio; Handy owns decoding, and
// Handy owns its selected model too: it rewrites its own settings file on exit,
// and silently changing the engine there would alter dictation in every app on
// the machine, not just this one. Pinning is per-call (`--model`) instead.

const HANDY_PATH_KEY = "astra.handy-path.v1";
const HANDY_MODEL_KEY = "astra.handy-model.v1";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Where Handy's executable lives; empty means "try its default install
 * locations, then PATH". A storage that refuses reads (private mode, blocked
 * site data) reads as unset rather than throwing out of the dictation path. */
export function handyPath(): string {
  try {
    return storage()?.getItem(HANDY_PATH_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setHandyPath(path: string): void {
  try {
    storage()?.setItem(HANDY_PATH_KEY, path);
  } catch {}
}

/** The Handy model id Astra pins for its own dictation and calls. Empty means
 * "whatever Handy has selected in its own window". */
export function handyModel(): string {
  try {
    return storage()?.getItem(HANDY_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setHandyModel(model: string): void {
  try {
    storage()?.setItem(HANDY_MODEL_KEY, model);
  } catch {}
}

/** The specs the desktop shell reports about this machine. */
export interface HandyDevice {
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  ramGB: number;
}

/** The three advice tiers, as catalog keys — typed as their own union so the
 * rule below and the panel that renders it cannot drift apart. */
export type HandyAdviceReasonKey =
  | "settings.wakeWord.engine.advice.light"
  | "settings.wakeWord.engine.advice.typical"
  | "settings.wakeWord.engine.advice.large";

export interface HandyModelAdvice {
  /** What to pick in Handy's own model dropdown. Product names are not
   * translated, so this is a label rather than a catalog key. */
  label: string;
  /** Lowercase fragments that identify this choice inside a Handy model id. */
  needles: string[];
  /** Why this machine lands on it, resolved through t() by the caller. */
  reasonKey: HandyAdviceReasonKey;
}

/**
 * Which model this machine should run, from the specs the shell measures.
 *
 * The rule is deliberately about the hardware, not about taste: every model
 * Handy ships runs locally, so the question is only whether the CPU can decode
 * faster than the user speaks. Whisper's large tiers are the most accurate and
 * the only ones that fall behind on a laptop without a GPU, which is exactly
 * where an int8 CPU model (Parakeet) or a tiny one (Moonshine) wins.
 */
export function recommendHandyModel(device: Pick<HandyDevice, "cores" | "ramGB">): HandyModelAdvice {
  const { cores, ramGB } = device;
  if (cores <= 2 || ramGB <= 4) {
    return {
      label: "Moonshine V2 Small",
      needles: ["moonshine"],
      reasonKey: "settings.wakeWord.engine.advice.light",
    };
  }
  if (cores >= 16 && ramGB >= 32) {
    return {
      label: "Whisper Large",
      needles: ["whisper"],
      reasonKey: "settings.wakeWord.engine.advice.large",
    };
  }
  return {
    // Both variants share a size and a speed class, so the family is what the
    // advice asks for: V3 for 25 languages, V2 for English only. Naming one of
    // them would make the "already installed" line lie on a machine running
    // the other.
    label: "Parakeet V2/V3 (int8)",
    needles: ["parakeet"],
    reasonKey: "settings.wakeWord.engine.advice.typical",
  };
}

/** True when the advice's model is among the ids Handy reports — so Settings
 * can say "already installed" instead of sending the user on an errand. */
export function handyAdviceInstalled(advice: HandyModelAdvice, ids: Array<string | null>): boolean {
  return ids.some(
    (id) => typeof id === "string" && advice.needles.some((needle) => id.toLowerCase().includes(needle)),
  );
}
