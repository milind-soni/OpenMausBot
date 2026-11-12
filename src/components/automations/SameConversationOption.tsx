import { t } from "@/lib/i18n";

/** Webhook and app-event automations: each run continues the previous run's conversation. */
export function SameConversationOption({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-hairline/40 bg-inset/40 px-3.5 py-3">
      <input type="checkbox" aria-label={t("automations.sameConversationLabel")} checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 accent-accent" />
      <span>
        <span className="block text-[13px] font-medium text-ink">{t("automations.sameConversationLabel")}</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">{t("automations.sameConversationHelp")}</span>
      </span>
    </label>
  );
}
