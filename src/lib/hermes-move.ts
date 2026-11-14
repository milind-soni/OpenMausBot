import { hermesMovePlan } from "../../shared/hermes-import";
import type { ImportedBot } from "../../shared/bot-import";
import { previewBotMove, type BotPreviewFacts } from "./bot-move";

export function previewHermesMove(bots: readonly ImportedBot[], facts: BotPreviewFacts) {
  return previewBotMove(bots, facts, hermesMovePlan);
}
