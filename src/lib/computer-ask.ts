import { t } from "./i18n";
import type { LocaleKey } from "@/locales";
import {
  computerAskHeadline, computerAskReasonLine, needsTheApp, turnsOnFromHere, type ComputerAskCard,
} from "../../shared/computer-ask";
import type { OptionCardData } from "../../shared/wire";

export interface ComputerAskWords {
  /** Who wants what, from which computer. */
  line: string;
  /** The bot's own reason, when it gave one. */
  why?: string;
  /** Why it isn't available now, with the fix when the fix is the app. */
  reason: string;
  /** Turn on (or Try again after a failure); absent when only the app there can fix it. */
  turnOn?: string;
  /** The app's download page, when the fix is installing, opening or updating it. */
  getApp?: string;
  /** How it ended, or that it is turning on; absent while it waits for an answer. */
  outcome?: string;
}

const OUTCOME: Partial<Record<ComputerAskCard["state"], LocaleKey>> = {
  "turning-on": "computerAsk.state.turningOn",
  on: "computerAsk.state.on",
  declined: "computerAsk.state.declined",
  ended: "computerAsk.state.ended",
};

/** A bot's ask to turn on what it needs from the person's computer, in their language; undefined for any other card. */
export function computerAskWords(card: Pick<OptionCardData, "computerAsk"> | undefined, name: string): ComputerAskWords | undefined {
  const ask = card?.computerAsk;
  if (!ask) return undefined;
  const headline = computerAskHeadline(ask);
  const reason = computerAskReasonLine(ask, name);
  const failed = ask.state === "failed";
  const outcome = OUTCOME[ask.state];
  return {
    line: t(headline.key as LocaleKey, { ...headline.params, name }),
    ...(ask.why ? { why: ask.why } : {}),
    reason: `${failed ? `${t("computerAsk.state.failed")} ` : ""}${t(reason.key as LocaleKey, reason.params)}`,
    ...(turnsOnFromHere(ask.reason) ? { turnOn: t(failed ? "computerAsk.action.tryAgain" : "computerAsk.action.turnOn") } : {}),
    ...(needsTheApp(ask.reason) ? { getApp: t("computerAsk.action.getApp") } : {}),
    ...(outcome ? { outcome: t(outcome, { name }) } : {}),
  };
}
