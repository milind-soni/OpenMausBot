import type { Message } from "@/state/store";

/** A provider's or the harness's question to the person: the one card every question is answered with. */
export const isQuestionCard = (card: Message["card"]): boolean =>
  Boolean(card?.requestId && !card.tool && (card.requestType === "question" || card.questionRequest));
