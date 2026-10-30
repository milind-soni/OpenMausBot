import { attemptLine, skippedToday } from "@/lib/app-automations";
import { useAppTriggers, type AppTrigger } from "@/lib/app-triggers";
import { lastWhen } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

const RECENT = 6;

/** What arrived lately, what was skipped today and why, and the day's limit for this computer or Cloud. */
export function AppEventsSection({ trigger }: { trigger: AppTrigger }) {
  const { attempts, service } = useAppTriggers();
  const recent = attempts.filter((attempt) => attempt.triggerId === trigger.id).slice(-RECENT).reverse();
  const skipped = skippedToday(trigger);
  return (
    <section data-app-events={trigger.id}>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{t("automations.panel.events")}</h3>
      {skipped && <p className="mb-2 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning">{skipped}</p>}
      {recent.length === 0
        ? <p className="text-[13px] text-ink-secondary">{t("automations.panel.noEvents")}</p>
        : <ul className="space-y-1">{recent.map((attempt) => {
          const line = attemptLine(attempt);
          const when = lastWhen(attempt.at);
          return (
            <li key={attempt.id} className="flex items-baseline gap-2 px-2 py-1 text-[13px]">
              <span className="shrink-0 text-ink-secondary">{when.charAt(0).toLocaleUpperCase() + when.slice(1)}</span>
              <span className={cn("shrink-0 font-semibold", line.mark === "✓" ? "text-success" : line.mark === "✗" ? "text-danger" : "text-ink-tertiary")}>{line.mark}</span>
              <span className="min-w-0 truncate text-ink" title={line.text}>{line.text}</span>
            </li>
          );
        })}</ul>}
      {service?.eventsPerDay && (
        <p className="mt-2 text-[11px] text-ink-tertiary">
          {t("automations.app.limit", { count: service.eventsPerDay.toLocaleString(), place: t(service.plan === "cloud" ? "automations.app.placeCloud" : "automations.app.placeDesktop") })}
        </p>
      )}
    </section>
  );
}
