import { HERMES_EXPORT_PROMPT, parseHermesExport } from "../../shared/hermes-import";
import { previewHermesMove } from "@/lib/hermes-move";
import { BotMoveDialog, type BotMoveAdapter, type BotMoveDialogProps } from "./BotMoveDialog";

const adapter: BotMoveAdapter = {
  source: "hermes", prompt: HERMES_EXPORT_PROMPT,
  titleKey: "settings.import.hermesTitle", introKey: "hermesMove.intro",
  pausedReportKey: "hermesMove.pausedReport", filesStayKey: "hermesMove.filesStay",
  parse: parseHermesExport, preview: previewHermesMove,
};

export function HermesMoveDialog(props: BotMoveDialogProps) {
  return <BotMoveDialog {...props} adapter={adapter} />;
}
