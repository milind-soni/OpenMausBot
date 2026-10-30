// The Today page's wire shape: what a person's bots finished in a window,
// what only the person can unblock, and an estimate of the time it saved.
import type { PlaceRow } from "./place-view.ts";
import type { OutcomeCategory, OutcomeCounts } from "./today-outcomes.ts";
import type { RoutineRunTrigger } from "./routines.ts";
import type { TrialCreditRefusal } from "./trial-credit.ts";

/** Who opened a piece of work: a schedule, a webhook, another bot, a call
 * through the API, a message relayed from another app, or the person. */
export type TodayStarter = RoutineRunTrigger | "bot" | "api" | "relay" | "person";

export interface TodayLine {
  /** Stable within a report: a digest message id or a routine run id. */
  id: string;
  at: number;
  botId: string;
  /** Absent when the work never reached a conversation (a missed run). */
  threadId?: string;
  routineId?: string;
  /** A routine's name, or the first sentence of the bot's last reply. */
  title: string;
  ok: boolean;
  /** The failure's own words, when the work failed. */
  error?: string;
  startedBy?: TodayStarter;
  outcomes: OutcomeCounts;
}

/** Only what the person can fix: never an approval. Each kind has exactly
 * one next action in the clients. */
export type NeedsYouItem =
  | { kind: "signed-out"; id: string; at: number; instanceId: string; botIds: string[]; threadId?: string }
  | { kind: "usage-limit"; id: string; at: number; instanceId?: string; botIds: string[]; threadId: string; text: string }
  | { kind: "out-of-credit"; id: string; at: number; credit: TrialCreditRefusal; botIds: string[]; threadId: string }
  | { kind: "connection"; id: string; at: number; app: string; botIds: string[]; threadId: string; text: string }
  | { kind: "place"; id: string; at: number; place: PlaceRow; botIds: string[]; threadId: string }
  | { kind: "question"; id: string; at: number; botId: string; threadId: string; text: string }
  /** On a Team Cloud: a teammate tagged this person, or a bot passed them a message. `from` names who, and `fromEmail`
   * is that teammate's address when a person (not a bot) sent it; `messageId` is the line to open. It goes once they
   * open that conversation or write in it. */
  | { kind: "message"; id: string; at: number; botId: string; threadId: string; messageId?: string; from: string; fromEmail?: string; text: string };

export interface TodayReport {
  since: number;
  until: number;
  /** Categories with at least one finished outcome, in OUTCOME_CATEGORIES order. */
  tiles: Array<{ category: OutcomeCategory; count: number }>;
  minutesSaved: number;
  /** Routine runs (scheduled, webhook, manual and startup) that finished in the window. */
  routines: { ok: number; failed: number };
  needsYou: NeedsYouItem[];
  /** Newest first, at most TODAY_MAX_LINES. */
  lines: TodayLine[];
  /** Finished lines left out past TODAY_MAX_LINES. */
  moreLines: number;
  /** Routines the viewer can see, so an empty page can name its next step. */
  routineCount: number;
}

export const TODAY_MAX_LINES = 300;
/** The furthest back a report reads; Needs you always looks this far. */
export const TODAY_MAX_WINDOW_MS = 8 * 24 * 60 * 60_000;
export const NEEDS_YOU_WINDOW_MS = 7 * 24 * 60 * 60_000;
