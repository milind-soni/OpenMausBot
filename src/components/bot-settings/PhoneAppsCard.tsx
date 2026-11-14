import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { nextPhoneApps, phoneAppRows, phoneNames, usePhones } from "@/lib/phones";
import type { Bot } from "@/state/store";
import type { BotPatch } from "./useBotSettingsDerived";

export function PhoneAppsCard({ bot, patch }: { bot: Bot; patch: (patch: BotPatch) => void }) {
  const { phones } = usePhones();
  if (phones.length === 0) return null;
  const rows = phoneAppRows(bot, phones);
  return <div className="rounded-xl bg-card p-4" data-testid="access-phone-apps">
    <div className="text-[15px] font-medium text-ink">{t("botAccess.phone.title")}</div>
    <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.phone.subtitle", { phone: phoneNames(phones) })}</div>
    {bot.phoneApps === undefined && <div className="mt-1 text-[12px] text-ink-secondary">{t("botAccess.phone.default")}</div>}
    <div className="mt-3 flex flex-col divide-y divide-hairline/20 rounded-lg bg-inset">
      {rows.map(({ cap, grant, onPhone }) => {
        const label = t(`botAccess.phone.cap.${cap}` as LocaleKey);
        return <div key={cap} className={cn("flex flex-wrap items-center justify-between gap-3 px-3 py-1.5", !onPhone && "opacity-50")}>
          <span className="min-w-0 text-[13px] text-ink">{label}{!onPhone && <span className="ml-2 text-[11px] text-ink-secondary">{t("botAccess.phone.notOnPhone")}</span>}</span>
          <div className="flex shrink-0 gap-0.5 rounded-md bg-card p-0.5" role="group" aria-label={label}>
            {([[null, t("botAccess.scopes.off")], ["read", t("botAccess.scopes.read")], ["write", t("botAccess.scopes.readWrite")]] as const).map(([value, text]) =>
              <button key={text} type="button" disabled={!onPhone} aria-pressed={grant === value} onClick={() => patch({ phoneApps: nextPhoneApps(bot, cap, value) })}
                className={cn("rounded px-2 py-0.5 text-[12px] font-medium", grant === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}>{text}</button>)}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
