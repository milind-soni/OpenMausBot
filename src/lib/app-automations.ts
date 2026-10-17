// An app-event automation as a person reads it: "When you get an email from Acme, Scout drafts a reply", how often it
// checks, what it skipped today, and what needs the person.
import { t } from "@/lib/i18n";
import type { AppEventAttempt, AppTrigger } from "@/lib/app-triggers";

const GMAIL_MESSAGE = "GMAIL_NEW_GMAIL_MESSAGE";

function channel(config: Record<string, unknown>): string | undefined {
  const value = Object.entries(config).find(([key, raw]) => /channel/i.test(key) && typeof raw === "string" && raw.trim())?.[1] as string | undefined;
  if (!value) return undefined;
  return value.startsWith("#") || /^[CGD][A-Z0-9]{6,}$/.test(value) ? value : `#${value}`;
}

/** "When you get an email from Acme about “order”", "When a new Slack message arrives in #sales". */
export function appWhen(trigger: Pick<AppTrigger, "app" | "appName" | "event" | "eventName" | "filter" | "config">): string {
  const filter = trigger.filter ?? {};
  const room = trigger.app === "slack" ? channel(trigger.config) : undefined;
  const parts = [
    room && t("automations.app.in", { value: room }),
    filter.from && t("automations.app.from", { value: filter.from }),
    filter.subject && t("automations.app.about", { value: filter.subject }),
    filter.label && t("automations.app.labeled", { value: filter.label }),
    filter.text && t("automations.app.mentioning", { value: filter.text }),
  ].filter(Boolean);
  const details = parts.length ? ` ${parts.join(" ")}` : "";
  if (trigger.event === GMAIL_MESSAGE) return t("automations.app.when.email", { details });
  if (trigger.app === "slack" && /MESSAGE/.test(trigger.event)) return t("automations.app.when.slack", { details });
  return t("automations.app.when.event", { event: trigger.eventName, app: trigger.appName, details });
}

export function appProblem(trigger: Pick<AppTrigger, "appName" | "problem">): { reason: string; fix: "reconnect" | "edit" } | null {
  if (trigger.problem?.kind === "reconnect") return { reason: t("automations.reason.reconnect", { app: trigger.appName }), fix: "reconnect" };
  if (trigger.problem?.kind === "error") return { reason: t("automations.reason.appError", { app: trigger.appName, error: trigger.problem.text }), fix: "edit" };
  return null;
}

/** Parts of the grey line: how it is checked, and a wait for its first event. */
export function appStatusParts(trigger: AppTrigger, hasRun: boolean): string[] {
  const parts: string[] = [];
  if (trigger.delivery === "poll") parts.push(t("automations.app.checks"));
  if (!hasRun && !trigger.lastEventAt) parts.push(t(trigger.event === GMAIL_MESSAGE ? "automations.app.waitingEmail" : "automations.app.waiting"));
  return parts;
}

/** The chat card's line before the first run: "Checks every 15 minutes · waiting for the first email". */
export function appWaitingLine(trigger: AppTrigger): string {
  const line = appStatusParts(trigger, false).join(" · ");
  return line.charAt(0).toLocaleUpperCase() + line.slice(1);
}

/** "12 skipped today: daily limit", naming the reason most of them had. */
export function skippedToday(trigger: Pick<AppTrigger, "skipped">, now = Date.now()): string | null {
  const skipped = trigger.skipped;
  if (!skipped || skipped.day !== new Date(now).toISOString().slice(0, 10)) return null;
  const reasons = [
    ["dailyLimit", skipped.dailyLimit, "automations.skip.dailyLimit"],
    ["queueFull", skipped.queueFull, "automations.skip.queueFull"],
    ["expired", skipped.expired, "automations.skip.expired"],
    ["tooMany", skipped.tooMany, "automations.skip.tooMany"],
  ] as const;
  const count = reasons.reduce((sum, [, value]) => sum + value, 0);
  if (!count) return null;
  const main = [...reasons].sort((left, right) => right[1] - left[1])[0]!;
  return t("automations.panel.skippedToday", { count, reason: t(main[2]) });
}

const OUTCOME = {
  started: "automations.event.started",
  joined: "automations.event.joined",
  filtered: "automations.event.filtered",
  duplicate: "automations.event.duplicate",
  skipped: "automations.event.skipped",
  rejected: "automations.event.rejected",
} as const;

export function attemptLine(attempt: AppEventAttempt): { mark: "✓" | "·" | "✗"; text: string } {
  const mark = attempt.outcome === "started" || attempt.outcome === "joined" ? "✓" : attempt.outcome === "rejected" ? "✗" : "·";
  return { mark, text: [t(OUTCOME[attempt.outcome]), attempt.preview].filter(Boolean).join(" · ") };
}
