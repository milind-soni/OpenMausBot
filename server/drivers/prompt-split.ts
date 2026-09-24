// The stable/volatile prompt split, shared by the drivers that deliver it.
// The stable half is everything that must stay byte-identical for a
// provider's cached prefix (or a spawned CLI's session contract) to
// survive; the volatile half (memory, mentions, outstanding teammate
// work, recent work) legitimately changes mid-conversation and reaches
// the model inside the turn that changed it, after the cacheable prefix.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SendTurnInput } from "../contracts.ts";

/** The halves of a turn's system prompt. The stable half is null for a
 * legacy single-block turn, so callers keep their pre-split behaviour. */
export interface PromptHalves {
  stable: string | null;
  volatile: string;
}

/** Read the split off a turn. Both halves must be present: a driver that
 * receives only the unsplit system field was called through a path that
 * never split it. */
export function promptHalves(
  turn: Pick<SendTurnInput, "system" | "systemStable" | "systemVolatile">,
): PromptHalves {
  const { systemStable, systemVolatile } = turn;
  if (typeof systemStable !== "string" || typeof systemVolatile !== "string") {
    return { stable: null, volatile: "" };
  }
  return { stable: systemStable, volatile: systemVolatile };
}

export const VOLATILE_CONTEXT_NOTE_PREFIX =
  "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:";

export const VOLATILE_CONTEXT_CLEARED_NOTE =
  "The OpenMausBot context notes from earlier in this conversation (memory, mentions, outstanding teammate work) have been cleared; the standing instructions still apply.";

/** The labelled block that carries a changed volatile half inside a user
 * turn. A half that is empty and always was needs no note; one that was
 * cleared announces the removal so the model stops relying on it. */
export function volatileContextNote(volatile: string, hadVolatile: boolean): string {
  const text = volatile.trim();
  if (text) return VOLATILE_CONTEXT_NOTE_PREFIX + "\n\n" + text;
  return hadVolatile ? VOLATILE_CONTEXT_CLEARED_NOTE : "";
}

/** Prepend a delivered note to the turn text: the one composition shape
 * every split-aware driver uses. */
export function withContextNote(note: string, text: string): string {
  if (!note) return text;
  return text ? note + "\n\n" + text : note;
}

/** Fingerprints of the halves a durable native session last carried. */
export interface PromptSplitReceipt {
  stable: string;
  volatile: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const EMPTY_FINGERPRINT = digest("");

export function promptSplitFingerprints(stable: string, volatile: string): PromptSplitReceipt {
  return { stable: digest(stable), volatile: digest(volatile) };
}

const receiptPath = (scope: string, key: string) =>
  join(DATA_DIR, "prompt-split", digest(JSON.stringify([scope, key])) + ".json");

/** Which halves a native session (an ACP session id, a pi session file)
 * last carried. Unknown - never tracked, or tracked before this file
 * existed - reads as null, and the caller re-delivers the full prompt
 * once. */
export function readPromptSplitReceipt(scope: string, key: string): PromptSplitReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(receiptPath(scope, key), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { stable?: unknown; volatile?: unknown };
      if (typeof record.stable === "string" && typeof record.volatile === "string") {
        return { stable: record.stable, volatile: record.volatile };
      }
    }
  } catch {
    /* a missing or corrupt receipt is simply unknown */
  }
  return null;
}

export function writePromptSplitReceipt(scope: string, key: string, receipt: PromptSplitReceipt): void {
  mkdirSync(join(DATA_DIR, "prompt-split"), { recursive: true });
  writeFileAtomic(receiptPath(scope, key), JSON.stringify(receipt), { mode: 0o600 });
}

/** Compose the prompt for a session that persists its own history (ACP
 * agents, pi): the full system block rides only when this native session
 * has not carried it - or carried a different one, which re-delivers the
 * current copy the way a pre-split turn always did - and a changed
 * volatile half rides as a labelled note. Otherwise the turn text goes
 * through bare, so an ordinary memory write neither appends a second copy
 * of the prompt to the session nor re-prices its cached prefix.
 * perTurnVolatile marks a turn whose volatile half describes this very
 * turn (a mention): its note is delivered even when the text is unchanged. */
export function splitSessionPrompt(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  fullSystem: string | undefined,
  text: string,
  perTurnVolatile = false,
): { text: string; receipt: PromptSplitReceipt } {
  const receipt = promptSplitFingerprints(stable, volatile);
  if (previous === null || previous.stable !== receipt.stable) {
    return { text: fullSystem ? fullSystem + "\n\n" + text : text, receipt };
  }
  const note = previous.volatile === receipt.volatile && !perTurnVolatile
    ? ""
    : volatileContextNote(volatile, previous.volatile !== EMPTY_FINGERPRINT);
  return { text: withContextNote(note, text), receipt };
}
