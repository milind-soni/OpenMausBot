import { byLanguage } from "./language.ts";
import { serverLine } from "./server-lines.ts";

export interface ComputerHolder {
  name: string;
  task?: string;
}

const minutes = (ms: number, language?: string): string => {
  const value = ms >= 60_000 ? Math.round(ms / 60_000) : Math.round(ms / 1000);
  const key = ms >= 60_000
    ? value === 1 ? "server.localeCoverage.waitMinuteOne" : "server.localeCoverage.waitMinuteMany"
    : value === 1 ? "server.localeCoverage.waitSecondOne" : "server.localeCoverage.waitSecondMany";
  return serverLine(language, key, { count: value });
};

export function computerWaitDuration(ms: number, language?: string): string {
  return ms < 1_000 ? serverLine(language, "server.localeCoverage.waitUnderSecond") : minutes(ms, language);
}

const holderPhrase = (holder: ComputerHolder, language?: string, still = false): string => {
  const key = holder.task
    ? still ? "server.localeCoverage.waitHolderTaskStill" : "server.localeCoverage.waitHolderTask"
    : still ? "server.localeCoverage.waitHolderStill" : "server.localeCoverage.waitHolder";
  return serverLine(language, key, { name: holder.name, task: holder.task ?? "" });
};

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

export function computerWaitingText(holder?: ComputerHolder | null, queue?: WaitQueueFact, language?: string): string {
  const position = queue?.position && queue.position > 0 ? queue.position : undefined;
  const place = position ? serverLine(language, "server.localeCoverage.waitQueuePlace", {
    position: byLanguage({ en: ordinal(position), de: String(position), zh: String(position), "zh-tw": String(position) }, language),
  }) : "";
  const estimate = queue?.estimateMs !== undefined
    ? serverLine(language, "server.localeCoverage.waitEstimate", { duration: computerWaitDuration(queue.estimateMs, language) }) : "";
  // Behind more than the holder: the freed seat goes to the front waiter first.
  const starts = position && position > 1
    ? serverLine(language, "server.localeCoverage.waitStartsAhead")
    : holder
      ? serverLine(language, "server.localeCoverage.waitStartsHeld")
      : serverLine(language, "server.localeCoverage.waitStartsFree");
  if (!holder) return serverLine(language, "server.localeCoverage.waitNoHolder", { place, starts, estimate });
  return serverLine(language, "server.localeCoverage.waitWithHolder", { place, holder: holderPhrase(holder, language), starts, estimate });
}

export function computerFreeAfterText(holder: ComputerHolder | null | undefined, waitedMs: number, language?: string): string {
  const who = holder ? serverLine(language, "server.localeCoverage.waitPastHolder", { holder: holder.task ? `${holder.name} · ${holder.task}` : holder.name }) : "";
  return serverLine(language, "server.localeCoverage.waitFree", { duration: computerWaitDuration(waitedMs, language), who });
}

export function computerStoppedWaitingText(holder: ComputerHolder | null | undefined, waitedMs: number, language?: string): string {
  const who = holder ? ` — ${holderPhrase(holder, language)}` : "";
  return serverLine(language, "server.localeCoverage.waitStopped", { duration: computerWaitDuration(waitedMs, language), who });
}

export function computerParkedText(holder: ComputerHolder | null | undefined, ceilingMs: number, language?: string): string {
  const who = holder ? ` — ${holderPhrase(holder, language, true)}` : "";
  return serverLine(language, "server.localeCoverage.waitParked", { duration: minutes(ceilingMs, language), who });
}

export function computerPersonAwayText(ceilingMs: number): string {
  return `A person has had control of this computer for over ${minutes(ceilingMs)}, so this call was NOT performed and this turn stops waiting for them. ` +
    "Pause this task: tell the person you are waiting for them to hand control back, and take a fresh screenshot before your next action once they have.";
}
