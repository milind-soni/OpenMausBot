import { CONTROL_BUSY_OPENING, CONTROL_NOT_READY_OPENING } from "./control-client.ts";

export interface ComputerHolder {
  name: string;
  task?: string;
}

const minutes = (ms: number): string => {
  const value = ms >= 60_000 ? Math.round(ms / 60_000) : Math.round(ms / 1000);
  const unit = ms >= 60_000 ? "minute" : "second";
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};

export function computerWaitDuration(ms: number): string {
  return ms < 1_000 ? "under a second" : minutes(ms);
}

const holderPhrase = (holder: ComputerHolder): string =>
  holder.task ? `${holder.name} is running ${holder.task}` : `${holder.name} is using it`;

export interface WaitQueueFact {
  position?: number;
  estimateMs?: number;
}

const ordinal = (position: number): string => {
  const mod100 = position % 100;
  const mod10 = position % 10;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th";
  return `${position}${suffix}`;
};

export function computerWaitingText(holder?: ComputerHolder | null, queue?: WaitQueueFact): string {
  const position = queue?.position && queue.position > 0 ? queue.position : undefined;
  const place = position ? ` — ${ordinal(position)} in queue` : "";
  const estimate = queue?.estimateMs !== undefined ? `; recent waits here have taken ${computerWaitDuration(queue.estimateMs)}` : "";
  // Behind more than the holder: the freed seat goes to the front waiter first.
  const starts = position && position > 1
    ? "Starts automatically when the turns ahead finish"
    : holder
      ? "Starts automatically when that finishes"
      : "Starts automatically when it is free";
  if (!holder) return `Waiting for its turn on this computer${place}. ${starts}${estimate}.`;
  return `Waiting for its turn on this computer${place} — ${holderPhrase(holder)}. ${starts}${estimate}.`;
}

export function computerFreeAfterText(holder: ComputerHolder | null | undefined, waitedMs: number): string {
  const who = holder ? ` (${holder.task ? `${holder.name} · ${holder.task}` : holder.name} held it)` : "";
  return `Computer free — continuing after waiting ${computerWaitDuration(waitedMs)}${who}`;
}

export function computerStoppedWaitingText(holder: ComputerHolder | null | undefined, waitedMs: number): string {
  const who = holder ? ` — ${holderPhrase(holder)}` : "";
  return `Stopped waiting for the computer after ${computerWaitDuration(waitedMs)}${who}.`;
}

export function computerParkedText(holder: ComputerHolder | null | undefined, ceilingMs: number): string {
  const who = holder ? ` — ${holderPhrase(holder).replace(" is running ", " is still running ").replace(" is using it", " is still using it")}` : "";
  return `Computer still busy after ${minutes(ceilingMs)}${who}. Parked — it continues automatically when the computer is free.`;
}

export function computerPersonAwayText(ceilingMs: number): string {
  return `A person has had control of this computer for over ${minutes(ceilingMs)}, so this call was NOT performed and this turn stops waiting for them. ` +
    "Pause this task: tell the person you are waiting for them to hand control back, and take a fresh screenshot before your next action once they have.";
}

/** No holder (the seat may be between turns), and no promise to resume: a goal step that parks is reassigned, not continued. */
export function computerParkedRefusal(ceilingMs: number): string {
  return `This turn waited ${minutes(ceilingMs)} for this computer without getting it, so this call was NOT performed. ` +
    "Stop calling the computer tools now; nothing is broken.";
}

export const isComputerParkedRefusal = (text: string): boolean =>
  /^This turn waited \d+ (?:second|minute)s? for this computer without getting it, so this call was NOT performed\./u.test(text);

export interface ComputerContention {
  position?: number;
  heldForMs?: number;
  estimateMs?: number;
}

const timings = (facts: ComputerContention, held: boolean): string[] => [
  held && facts.heldForMs !== undefined ? `the other thread has had it ${computerWaitDuration(facts.heldForMs)}` : "",
  facts.estimateMs !== undefined ? `recent waits ${computerWaitDuration(facts.estimateMs)}` : "",
].filter(Boolean);
const inBrackets = (parts: string[]): string => (parts.length ? ` (${parts.join("; ")})` : "");

export function computerBusyText(facts: ComputerContention): string {
  const head = `${CONTROL_BUSY_OPENING} This call was not performed. No screen or app state was checked.`;
  const parts = timings(facts, true);
  if (!facts.position) {
    const said = parts.length ? ` ${parts.join("; ").replace(/^t/u, "T")}.` : "";
    return `${head}${said} To check again, take a screenshot instead of ending your turn.`;
  }
  return `${head} This turn is ${ordinal(facts.position)} in line${inBrackets(parts)} and gets it automatically. To keep waiting, take a screenshot.`;
}

/** Queued, but nobody holds the seat at this instant (the turn ahead has not taken it yet). */
export function computerQueuedText(facts: ComputerContention & { position: number }): string {
  return `${CONTROL_NOT_READY_OPENING}, so this call was NOT performed. This turn is ${ordinal(facts.position)} in line${inBrackets(timings(facts, false))} and gets it automatically. ` +
    "No screen or app state was checked. To keep waiting, take a screenshot.";
}
