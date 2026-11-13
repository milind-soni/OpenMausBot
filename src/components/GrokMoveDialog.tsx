import { GROK_EXPORT_PROMPT, parseGrokExport } from "../../shared/grok-import";
import { previewGrokMove, lookForGrokBot, foundExports } from "@/lib/grok-move";
import { BotMoveDialog, type BotMoveAdapter, type BotMoveDialogProps } from "./BotMoveDialog";
export { BotCounts, BotMoveLines as GrokMoveLines } from "./BotMoveDialog";

const adapter: BotMoveAdapter = {
  source: "grok", prompt: GROK_EXPORT_PROMPT,
  titleKey: "settings.import.grokTitle", introKey: "grokMove.intro",
  pausedReportKey: "grokMove.pausedReport", filesStayKey: "grokMove.filesStay",
  parse: parseGrokExport, preview: previewGrokMove,
  find: lookForGrokBot, found: foundExports,
};

export function GrokMoveDialog(props: BotMoveDialogProps) {
  return <BotMoveDialog {...props} adapter={adapter} />;
}
