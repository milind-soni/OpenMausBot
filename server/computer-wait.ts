// What a turn says while it waits for a computer another turn is using.
//
// The chip used to read "Waiting for computer — X / Y is using it; will
// continue automatically", which people read as an error about a machine
// they could not see. It is a queue position: this turn is behind one named
// turn on one desktop, and it starts on its own when that turn ends. Say
// that, name the holder as a bot running a thread, and keep the same words
// on every surface (chat chip, room chip, the gate's refusal) so a person
// who has read it once recognises it everywhere.

/** Who holds the computer this turn is waiting for: a bot and, when the
 * holder is one of its threads, that thread's title; or a room's name. */
export interface ComputerHolder {
  name: string;
  task?: string;
}

/** Whole minutes, or seconds under one minute, for the give-up notice. */
const minutes = (ms: number): string => ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;

const holderPhrase = (holder: ComputerHolder): string =>
  holder.task ? `${holder.name} is running ${holder.task}` : `${holder.name} is using it`;

/** The chip a turn shows while it is queued behind another turn's desktop. */
export function computerWaitingText(holder?: ComputerHolder | null): string {
  if (!holder) return "Waiting for its turn on this computer. Starts automatically when it is free.";
  return `Waiting for its turn on this computer — ${holderPhrase(holder)}. Starts automatically when that finishes.`;
}

/** The same chip once the wait landed and this turn holds the desktop. */
export function computerFreeText(): string {
  return "Computer free — continuing";
}

/** The same chip when the wait ended without the desktop: the turn was
 * stopped, or the claim was abandoned. */
export function computerWaitEndedText(): string {
  return "Stopped waiting for the computer";
}

/** The error after the wait ceiling: still names who holds it, and says
 * what a person can do — stop that turn, or move this one. */
export function computerStillBusyText(holder: ComputerHolder | null | undefined, ceilingMs: number): string {
  const who = holder ? ` — ${holderPhrase(holder).replace(" is running ", " is still running ").replace(" is using it", " is still using it")}` : "";
  return `Computer is still busy after ${minutes(ceilingMs)}${who}. Stop that turn, or run this on another computer.`;
}
