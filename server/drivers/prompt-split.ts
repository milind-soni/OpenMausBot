// The stable/volatile system-prompt split: the stable half stays byte-identical for a provider's
// cached prefix; a changed volatile half rides inside the turn that changed it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SendTurnInput } from "../contracts.ts";

export interface PromptHalves {
  stable: string | null;
  volatile: string;
}

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
  "The OpenMausBot context notes from earlier in this conversation have been cleared; the standing instructions still apply.";

export function volatileContextNote(volatile: string, hadVolatile: boolean): string {
  const text = volatile.trim();
  if (text) return VOLATILE_CONTEXT_NOTE_PREFIX + "\n\n" + text;
  return hadVolatile ? VOLATILE_CONTEXT_CLEARED_NOTE : "";
}

export function withContextNote(note: string, text: string): string {
  if (!note) return text;
  return text ? note + "\n\n" + text : note;
}

export interface PromptSplitReceipt {
  stable: string;
  volatile: string;
  turnsSinceFull?: number;
  lastUsed?: number;
  peakUsed?: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const EMPTY_FINGERPRINT = digest("");

export function promptSplitFingerprints(stable: string, volatile: string): PromptSplitReceipt {
  return { stable: digest(stable), volatile: digest(volatile) };
}

const receiptPath = (scope: string, key: string) =>
  join(DATA_DIR, "prompt-split", digest(JSON.stringify([scope, key])) + ".json");

export function readPromptSplitReceipt(scope: string, key: string): PromptSplitReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(receiptPath(scope, key), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { stable?: unknown; volatile?: unknown; turnsSinceFull?: unknown; lastUsed?: unknown; peakUsed?: unknown };
      if (typeof record.stable === "string" && typeof record.volatile === "string") {
        return {
          stable: record.stable,
          volatile: record.volatile,
          ...(typeof record.turnsSinceFull === "number" ? { turnsSinceFull: record.turnsSinceFull } : {}),
          ...(typeof record.lastUsed === "number" && record.lastUsed > 0 ? { lastUsed: record.lastUsed } : {}),
          ...(typeof record.peakUsed === "number" && record.peakUsed > 0 ? { peakUsed: record.peakUsed } : {}),
        };
      }
    }
  } catch {}
  return null;
}

export function writePromptSplitReceipt(scope: string, key: string, receipt: PromptSplitReceipt): void {
  mkdirSync(join(DATA_DIR, "prompt-split"), { recursive: true });
  writeFileAtomic(receiptPath(scope, key), JSON.stringify(receipt), { mode: 0o600 });
}

export function deletePromptSplitReceipt(scope: string, key: string): void {
  try {
    rmSync(receiptPath(scope, key));
  } catch {}
}

interface SplitTurn {
  full: boolean;
  note: string;
  receipt: PromptSplitReceipt;
}

function splitTurn(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  perTurnVolatile: boolean,
  reAnchorAfterTurns: number,
): SplitTurn {
  const fingerprints = promptSplitFingerprints(stable, volatile);
  const turnsSinceFull = typeof previous?.turnsSinceFull === "number" ? previous.turnsSinceFull : 0;
  const reAnchor = reAnchorAfterTurns > 0 && previous !== null && turnsSinceFull >= reAnchorAfterTurns;
  if (previous === null || previous.stable !== fingerprints.stable || reAnchor) {
    const hadVolatile = previous !== null && previous.volatile !== EMPTY_FINGERPRINT;
    return { full: true, note: volatileContextNote(volatile, hadVolatile), receipt: { ...fingerprints, turnsSinceFull: 0 } };
  }
  const note = previous.volatile === fingerprints.volatile && !perTurnVolatile
    ? ""
    : volatileContextNote(volatile, previous.volatile !== EMPTY_FINGERPRINT);
  return { full: false, note, receipt: { ...fingerprints, turnsSinceFull: turnsSinceFull + 1 } };
}

export interface PendingPromptSplitReceipt { key: string; receipt: PromptSplitReceipt; previous: PromptSplitReceipt | null }

/** Records a prompt the agent accepted, with the context use its turn last reported; after a compaction nothing is
 * recorded, so the next turn sends the whole prompt again. */
export function commitPromptSplitReceipt(
  scope: string,
  pending: PendingPromptSplitReceipt,
  usage: { compacted: boolean; last: number | null; peak: number | null },
): void {
  if (usage.compacted) return deletePromptSplitReceipt(scope, pending.key);
  const lastUsed = usage.last ?? (typeof pending.previous?.lastUsed === "number" ? pending.previous.lastUsed : undefined);
  writePromptSplitReceipt(scope, pending.key, {
    ...pending.receipt,
    ...(lastUsed === undefined ? {} : { lastUsed }),
    ...(usage.peak === null ? {} : { peakUsed: usage.peak }),
  });
}

/** reAnchorAfterTurns re-sends the full prompt after that many bare turns, for history rewrites no event reports. */
export function splitSessionPrompt(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  fullSystem: string | undefined,
  text: string,
  perTurnVolatile = false,
  reAnchorAfterTurns = 0,
): { text: string; receipt: PromptSplitReceipt } {
  const turn = splitTurn(stable, volatile, previous, perTurnVolatile, reAnchorAfterTurns);
  if (!turn.full) return { text: withContextNote(turn.note, text), receipt: turn.receipt };
  return { text: fullSystem ? fullSystem + "\n\n" + text : text, receipt: turn.receipt };
}

/** splitSessionPrompt for an agent that holds the stable half as its session's system prompt: what the turn carries is
 * the volatile half's note alone, the whole volatile half wherever splitSessionPrompt would send the full prompt. */
export function splitSessionNote(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  perTurnVolatile = false,
  reAnchorAfterTurns = 0,
): { note: string; receipt: PromptSplitReceipt } {
  const { note, receipt } = splitTurn(stable, volatile, previous, perTurnVolatile, reAnchorAfterTurns);
  return { note, receipt };
}

/** The stable half a per-thread process is keyed on: without the team roster (`systemRoster`), which a warm process takes
 * as a note (withRosterNote) when it changes, so adding, renaming or removing a bot relaunches no engine. */
export function keyedStable(turn: Pick<SendTurnInput, "systemStable" | "systemRoster">): string | undefined {
  const { systemStable: stable, systemRoster: roster } = turn;
  return stable !== undefined && roster ? stable.replace(roster, "") : stable;
}

/** The team roster as it is now, before `text`, when it differs from what the process last had (`had`). */
export function withRosterNote(text: string, roster: string, had: string): string {
  if (roster === had) return text;
  const note = `<system-reminder>\n${roster.trim() ? `The team roster changed since this session started. It replaces the roster in your instructions:\n\n${roster.trim()}` : "The team roster in your instructions is out of date: it has no members now."}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}

/** The volatile half as a reminder in a Claude turn, by the CLI's own out-of-band convention: on a
 * live session when it changed, and in a new process's first message (`launch`), so the launched
 * system prompt is the stable half alone and a relaunch keeps a prefix the provider already cached. */
export function withVolatileNote(text: string, volatile: string, launch = false): string {
  const body = !volatile.trim()
    ? "The notes that were in your instructions when this session started have been cleared."
    : launch
      ? `This part of your instructions changes from turn to turn, so it arrives here instead of in the system prompt. It replaces any earlier copy:\n\n${volatile.trim()}`
      : `This part of your instructions changed since this session started. It replaces the earlier copy:\n\n${volatile.trim()}`;
  const note = `<system-reminder>\n${body}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}
