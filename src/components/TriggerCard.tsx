import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";
import { Undo2, Zap } from "lucide-react";

import { automationFor, automationSentence, automationStatus, capital, cardAutomation, lastWhen, nextWhen, runLine } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { saveWebhookCredential, webhookCredentialStore } from "@/lib/webhook-credentials";
import { api, ApiError, useStore, type OptionCardData } from "@/state/store";
import { appWaitingLine } from "@/lib/app-automations";
import { useAppTriggers } from "@/lib/app-triggers";
import { useAllAutomationActions } from "./automations/app-actions";

// The editors live with the Automations page; a chat only loads one when Edit is pressed.
const RoutineEditor = lazy(async () => ({ default: (await import("./RoutinesPage")).RoutineEditor }));
const WebhookEditor = lazy(async () => ({ default: (await import("./WebhookTrigger")).WebhookEditor }));
const AppEventEditor = lazy(async () => ({ default: (await import("./automations/AppEventEditor")).AppEventEditor }));

const ACTION = "rounded-md px-1.5 py-0.5 font-medium hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50";

/** What a chat-made automation leaves in the conversation: one sentence, what happens next or what happened last. */
export function TriggerCard({ card, threadId }: { card: OptionCardData; threadId?: string }) {
  const { state, dispatch } = useStore();
  const actions = useAllAutomationActions();
  const appTriggers = useAppTriggers();
  const [editing, setEditing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string>();
  const ref = cardAutomation(card);
  if (!ref) return null;
  const automation = automationFor(ref, { routines: state.routines, webhooks: state.webhooks, appTriggers: appTriggers.triggers, runs: state.routineRuns, bots: state.bots });
  const fallbackName = card.routineRequest?.undo?.name ?? card.webhookRequest?.undo?.name ?? card.appTriggerRequest?.undo?.name ?? card.title;

  if (card.undone || !automation) {
    if (!card.undone && ref.kind === "schedule" && state.routinesLoadState === "loading") return null;
    if (!card.undone && ref.kind === "app" && !appTriggers.loaded) return null;
    return (
      <div data-trigger-card={ref.id} className="flex w-full max-w-[840px] items-center gap-2 text-[13px] text-ink-tertiary">
        {card.undone ? <Undo2 size={13} /> : <Zap size={13} />}
        <span>{card.undone ? t("automations.card.removed") : `${t("automations.card.gone")} · ${fallbackName}`}</span>
      </div>
    );
  }

  const botName = state.bots.find((bot) => bot.id === automation.botId)?.name ?? t("routines.unavailableBot");
  const sentence = automationSentence(automation, botName);
  const status = automationStatus(automation);
  const last = automation.runs.find((run) => run.status !== "queued");
  const next = automation.nextRunAt != null ? nextWhen(automation.nextRunAt) : null;
  const lastRan = last && `${t("automations.card.lastRan", { when: lastWhen(last.startedAt ?? last.scheduledFor) })} ${runLine(last).mark} ${runLine(last).text}`;
  let line: string;
  if (status.state === "paused") line = t("automations.status.paused");
  else if (status.state === "done") line = [t("automations.status.done"), lastRan].filter(Boolean).join(" · ");
  else if (status.state === "needs-you") line = t("automations.needsYou", { reason: status.reason ?? "" });
  else if (lastRan) line = [lastRan, next && t("automations.next", { when: next })].filter(Boolean).join(" · ");
  else line = next ? t("automations.card.next", { when: next }) : automation.appTrigger ? appWaitingLine(automation.appTrigger) : capital(t("automations.notRunYet"));

  const undo = () => {
    if (!threadId || !card.requestId || undoing) return;
    setUndoing(true);
    setError(undefined);
    api(`/api/threads/${threadId}/undo`, { method: "POST", body: JSON.stringify({ requestId: card.requestId }) })
      .catch((failure: unknown) => setError(failure instanceof ApiError && failure.body?.code === "changed-since"
        ? t("automations.card.changedSince")
        : failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setUndoing(false));
  };
  const visibleBots = state.bots.filter((bot) => !bot.hidden);

  return (
    <section data-trigger-card={automation.id} data-automation-status={status.state} aria-label={sentence} className="w-full max-w-[640px] rounded-xl border border-hairline/45 bg-card px-3.5 py-2.5 text-[13px]">
      <div className="flex items-start gap-2">
        <Zap size={14} className={cn("mt-0.5 shrink-0", status.state === "needs-you" ? "text-warning" : automation.enabled ? "text-accent" : "text-ink-tertiary")} />
        <button type="button" onClick={() => dispatch({ type: "showRoutines", view: "list", routineId: automation.id })} className="min-w-0 text-left font-medium leading-snug text-ink hover:text-accent-text">
          {t("automations.card.setUp", { sentence })}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[22px] text-[12px]">
        <span className={cn("min-w-0 flex-1 basis-48 truncate", status.state === "needs-you" ? "text-warning" : "text-ink-secondary")} title={line}>{line}</span>
        <span className="flex shrink-0 items-center gap-0.5 text-ink-secondary">
          {status.state !== "done" && <><button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.toggle(automation)} className={ACTION}>{automation.enabled ? t("automations.pause") : t("automations.resume")}</button><span aria-hidden="true">·</span></>}
          <button type="button" onClick={() => setEditing(true)} className={ACTION}>{t("automations.edit")}</button>
          {automation.kind === "webhook" && <><span aria-hidden="true">·</span><button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.copyAddress(automation.id)} className={ACTION}>{actions.copied === automation.id ? t("automations.address.copied") : t("automations.address.copy")}</button></>}
          {threadId && card.requestId && <><span aria-hidden="true">·</span><button type="button" onClick={undo} disabled={undoing} className={cn(ACTION, "text-accent")}>{undoing ? t("automations.card.undoing") : t("automations.card.undo")}</button></>}
        </span>
      </div>
      {(error || actions.error) && <div role="alert" className="mt-1 pl-[22px] text-[12px] text-warning">{error ?? actions.error}</div>}
      {/* On the page, not in the transcript: the transcript's scroller would clip it and the composer would cover Save. */}
      {editing && createPortal(
        <Suspense fallback={null}>
          {automation.kind === "app" ? <AppEventEditor trigger={automation.appTrigger} bots={visibleBots} onClose={() => setEditing(false)} /> : automation.kind === "schedule"
            ? <RoutineEditor routine={state.routines.find((routine) => routine.id === automation.id)} bots={visibleBots} plain onClose={() => setEditing(false)} />
            : <WebhookEditor webhook={state.webhooks.find((webhook) => webhook.id === automation.id)} bots={visibleBots} onClose={() => setEditing(false)} onCredential={(credential, id) => saveWebhookCredential(webhookCredentialStore(), id, credential)} />}
        </Suspense>,
        document.body,
      )}
    </section>
  );
}
