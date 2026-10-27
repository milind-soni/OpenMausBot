import { useState } from "react";
import { Check, Copy, Pause, Pencil, Play, RotateCw, Trash2, X } from "lucide-react";

import { automationStatus, capital, lastReceived, lastWhen, runLine, STATUS_WORD, webhookCalls, type Automation } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { loadWebhookCredentials, webhookCredentialStore } from "@/lib/webhook-credentials";
import { useStore } from "@/state/store";
import { AppEventsSection } from "./AppEventsSection";
import { useAllAutomationActions } from "./app-actions";
import { FixButton, StatusMark } from "./parts";

const RECENT = 5;
const BUTTON = "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium disabled:opacity-50";

/** One automation, simply: its sentence, its status, the last five runs, and what can be done to it. */
export function AutomationPanel({ automation, sentence, onClose, onEdit, onDeleted }: {
  automation: Automation;
  sentence: string;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { state } = useStore();
  const actions = useAllAutomationActions();
  const status = automationStatus(automation);
  const webhook = automation.kind === "webhook" ? state.webhooks.find((candidate) => candidate.id === automation.id) : undefined;
  const credential = webhook ? loadWebhookCredentials(webhookCredentialStore())[webhook.id] : undefined;
  const receiving = state.webhookIngress?.available !== false;
  const statusWord = t(STATUS_WORD[status.state]);
  const reason = status.state === "done" ? t("automations.reason.done") : status.reason;
  const calls = webhook ? webhookCalls(webhook.id, state.webhookAttempts) : [];
  const received = webhook ? lastReceived(webhook, state.webhookAttempts) : null;
  const [openCall, setOpenCall] = useState<string | null>(null);
  // Shown only on Show: More is opened for Recent calls, often on a shared screen.
  const [secretShown, setSecretShown] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const copySecret = async (secret: string) => {
    if (await copyText(secret) !== "copied") { actions.setError(t("automations.address.copyFailed")); return; }
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 1_800);
  };

  return (
    <aside aria-label={t("automations.panel.label")} className="flex h-full w-[min(380px,100vw)] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-start gap-3 border-b border-hairline/40 px-5 py-4">
        <h2 className="min-w-0 flex-1 text-[16px] font-semibold leading-snug text-ink">{sentence}</h2>
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("automations.panel.close")}><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]" data-automation-status={status.state}>
          <StatusMark status={status} />
          <span className={cn("font-medium", status.state === "needs-you" ? "text-warning" : "text-ink")}>{statusWord}</span>
          {reason && <span className="min-w-0 text-ink-secondary">{reason}</span>}
          <FixButton automation={automation} status={status} actions={actions} onEdit={onEdit} />
        </div>

        {webhook && (
          <section className="rounded-xl border border-hairline/45 bg-inset/50 p-3.5">
            <h3 className="text-[13px] font-medium text-ink">{t("automations.address.title")}</h3>
            <button type="button" disabled={Boolean(actions.busy) || !receiving} onClick={() => void actions.copyAddress(webhook.id)} className={cn(BUTTON, "mt-2.5 bg-accent text-accent-ink hover:brightness-110")}>
              {actions.copied === webhook.id ? <Check size={14} /> : <Copy size={14} />}
              {actions.copied === webhook.id ? t("automations.address.copied") : t("automations.address.copy")}
            </button>
            {(!receiving || !state.config?.cloudHome) && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{receiving ? t("automations.address.keepOpen") : t("automations.address.unavailable")}</p>}
            <details className="mt-2.5 text-[12px] text-ink-secondary">
              <summary className="cursor-pointer select-none font-medium text-ink-secondary hover:text-ink">{t("automations.more")}</summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                {received && (
                  <section aria-label={t("automations.received.title")}>
                    <p className="font-medium text-ink">{t("automations.received.title")} · {lastWhen(received.at)}</p>
                    <p className="mt-0.5">{t("automations.received.help")}</p>
                    <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-inset px-2.5 py-2 font-mono text-[11px] text-ink">{received.preview.slice(0, 1_000)}</pre>
                  </section>
                )}
                <section aria-label={t("automations.calls.title")}>
                  <p className="font-medium text-ink">{t("automations.calls.title")}</p>
                  {calls.length === 0 ? <p className="mt-0.5">{t("automations.calls.none")}</p> : (
                    <ul className="mt-1 space-y-0.5">{calls.map((call) => (
                      <li key={call.id} data-call={call.ok ? "ok" : "refused"}>
                        <button type="button" aria-expanded={openCall === call.id} onClick={() => setOpenCall((current) => (current === call.id ? null : call.id))} className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised">
                          <span className="shrink-0">{capital(lastWhen(call.at))}</span>
                          <span className={cn("shrink-0 font-semibold", call.ok ? "text-success" : "text-danger")}>{call.ok ? "✓" : "✗"}</span>
                          <span className="min-w-0 truncate text-ink">{call.reason}</span>
                        </button>
                        {openCall === call.id && <pre className="mx-1.5 mb-1 whitespace-pre-wrap break-all rounded-md bg-inset px-2 py-1.5 font-mono text-[11px] text-ink">{call.preview || t("automations.calls.empty")}</pre>}
                      </li>
                    ))}</ul>
                  )}
                </section>
                <p className="font-medium text-ink">{t("automations.address.showSecret")}</p>
                {credential ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-secret={secretShown ? "shown" : "masked"}>
                    <span className="min-w-0 break-all font-mono text-[11px]">{t("automations.address.secret", { secret: secretShown ? credential.secret : "••••••••" })}</span>
                    <button type="button" aria-label={t(secretShown ? "automations.address.hideSecretLabel" : "automations.address.showSecretLabel")} onClick={() => setSecretShown((shown) => !shown)} className="rounded-md px-1.5 py-0.5 font-medium text-ink hover:bg-raised">{t(secretShown ? "automations.address.hideSecret" : "automations.address.revealSecret")}</button>
                    <button type="button" aria-label={t("automations.address.copySecretLabel")} onClick={() => void copySecret(credential.secret)} className="rounded-md px-1.5 py-0.5 font-medium text-ink hover:bg-raised">{secretCopied ? t("automations.address.copied") : t("automations.address.copySecret")}</button>
                  </div>
                ) : <p className="break-all font-mono text-[11px]">{t("automations.address.secretUnknown")}</p>}
                <p>{t("automations.address.header")}</p>
                {webhook.eventTypes?.length ? <p>{t("automations.address.events", { events: webhook.eventTypes.join(", ") })}</p> : null}
                <button type="button" disabled={Boolean(actions.busy)} onClick={() => { if (window.confirm(t("automations.address.replaceConfirm"))) void actions.copyAddress(webhook.id, true); }} className="flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-ink hover:bg-raised"><RotateCw size={12} />{t("automations.address.replace")}</button>
              </div>
            </details>
          </section>
        )}

        {automation.appTrigger && <AppEventsSection trigger={automation.appTrigger} />}

        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{t("automations.panel.recent")}</h3>
          {automation.runs.length === 0
            ? <p className="text-[13px] text-ink-secondary">{t("automations.panel.noRuns")}</p>
            : <ul className="space-y-1">{automation.runs.slice(0, RECENT).map((run) => {
              const line = runLine(run);
              return (
                <li key={run.id}>
                  <button type="button" disabled={!run.threadId} onClick={() => actions.openRun(automation, run)} title={run.threadId ? t("automations.panel.open") : undefined}
                    className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-raised disabled:hover:bg-transparent">
                    <span className="shrink-0 text-ink-secondary">{line.when}</span>
                    <span className={cn("shrink-0 font-semibold", line.mark === "✓" ? "text-success" : line.mark === "✗" ? "text-danger" : "text-warning")}>{line.mark}</span>
                    <span className="min-w-0 truncate text-ink">{line.text}</span>
                  </button>
                </li>
              );
            })}</ul>}
        </section>
        {actions.error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{actions.error}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-hairline/40 px-5 py-3.5">
        <button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.runNow(automation)} className={cn(BUTTON, "bg-accent text-accent-ink hover:brightness-110")}><Play size={14} />{actions.busy === `run:${automation.id}` ? t("automations.starting") : t("automations.runNow")}</button>
        {status.state !== "done" && <button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.toggle(automation)} className={cn(BUTTON, "border border-hairline/50 bg-control text-ink hover:bg-raised-hover")}>{automation.enabled ? <Pause size={14} /> : <Play size={14} />}{automation.enabled ? t("automations.pause") : t("automations.resume")}</button>}
        <button type="button" onClick={onEdit} className={cn(BUTTON, "text-ink hover:bg-raised")}><Pencil size={14} />{t("automations.edit")}</button>
        <button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.remove(automation, t("automations.deleteConfirm", { sentence })).then((gone) => { if (gone) onDeleted(); })} className={cn(BUTTON, "text-danger hover:bg-danger/10")}><Trash2 size={14} />{t("automations.delete")}</button>
      </div>
    </aside>
  );
}
