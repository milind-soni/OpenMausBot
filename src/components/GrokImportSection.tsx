import { t } from "@/lib/i18n";
import { GrokMoveDialog } from "./lazy-screens";
import { BotImportSection } from "./BotImportSection";
import { GrokBotMark } from "./GrokBotMark";

export function GrokImportSection() {
  return <BotImportSection source="grok" title={t("settings.import.grokTitle")} mark={<GrokBotMark size={18} />} Dialog={GrokMoveDialog} />;
}
