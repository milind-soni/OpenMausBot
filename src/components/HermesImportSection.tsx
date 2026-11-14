import { t } from "@/lib/i18n";
import { HermesMoveDialog } from "./lazy-screens";
import { BotImportSection } from "./BotImportSection";
import { BookOpen } from "lucide-react";

export function HermesImportSection() {
  return <BotImportSection source="hermes" title={t("settings.import.hermesTitle")} mark={<BookOpen size={18} />} Dialog={HermesMoveDialog} />;
}
