import { Switch } from "../SettingsPrimitives";
import { t } from "@/lib/i18n";

export function MinimumAiMode({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <div className="flex items-start justify-between gap-4 rounded-xl border border-hairline/50 bg-inset px-4 py-3">
    <div><div className="text-[13px] font-medium text-ink">{t("routines.minimumAi.title")}</div>
      <p className="mt-1 text-[12px] text-ink-secondary">{t("routines.minimumAi.help")}</p></div>
    <Switch aria-label={t("routines.minimumAi.title")} checked={enabled} onClick={() => onChange(!enabled)} />
  </div>;
}
