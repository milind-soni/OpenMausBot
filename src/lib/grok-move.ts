import { api } from "@/state/store";
import { grokMovePlan, mergeGrokBots, parseGrokExport, type GrokBot } from "../../shared/grok-import";
import { botImportErrorText as grokErrorText, NOTHING_FOUND, previewBotMove, type BotLook as GrokLook, type BotPreviewFacts as GrokPreviewFacts } from "./bot-move";

export { botImportErrorText as grokErrorText, NOTHING_FOUND, runBotMove as runGrokMove } from "./bot-move";
export type { BotLook as GrokLook, BotPreview as GrokPreview, BotPreviewFacts as GrokPreviewFacts, MovedBot as GrokMovedBot, BotMoveReport as GrokReport } from "./bot-move";

export function lookForGrokBot(): Promise<GrokLook> {
  return api<Partial<GrokLook> | null>("/api/setup-import/grok", { timeoutMs: 10_000 }).then(
    (look) => ({ files: Array.isArray(look?.files) ? look.files : [], bots: Array.isArray(look?.bots) ? look.bots : [] }),
    () => NOTHING_FOUND,
  );
}

export interface FoundExports {
  bots: GrokBot[];
  refused: Array<{ file: string; error: string }>;
}

/** Every file found, joined by Bot: a split export comes together and a saved-twice one counts once. A refused file says
 * why and costs the others nothing. Oldest first, so the newest copy wins. */
export function foundExports(files: GrokLook["files"]): FoundExports {
  const refused: FoundExports["refused"] = [];
  const bots = [...files].sort((a, b) => a.modifiedAt - b.modifiedAt).flatMap((file) => {
    try {
      return parseGrokExport(file.text);
    } catch (cause) {
      refused.push({ file: file.name, error: grokErrorText(cause) });
      return [];
    }
  });
  return { bots: mergeGrokBots(bots), refused };
}


export function previewGrokMove(bots: readonly GrokBot[], facts: GrokPreviewFacts) {
  return previewBotMove(bots, facts, grokMovePlan);
}
