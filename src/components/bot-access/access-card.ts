import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";

type Card = Pick<NonNullable<Message["card"]>, "accessRequest" | "options">;

/** Someone's ask to chat with a bot, in this person's language: the question and its two choices. Null for any other
 * card, which shows its own words. */
export function accessRequestWords(card: Card | undefined): { question: string; options: string[] } | null {
  const ask = card?.accessRequest;
  if (!ask) return null;
  return { question: t("botAccess.request.question", { name: ask.name, bot: ask.botName }), options: [t("botAccess.request.allow"), t("botAccess.request.notNow")] };
}

/** What a tap on a shown choice answers: the card's own option at the same place, whatever language it was shown in. */
export function cardAnswerFor(card: Card | undefined, label: string): string {
  const at = accessRequestWords(card)?.options.indexOf(label) ?? -1;
  return at >= 0 ? card?.options[at] ?? label : label;
}
