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
