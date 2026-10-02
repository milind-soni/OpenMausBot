// Triggers: webhooks as a sentence. "When <something happens>, <this bot>
// should <do this>." The builder on top is the same create call the
// Automations page's Webhooks tab makes (POST /api/webhooks); the source
// presets only fill in the name. Everything the full editor offers — event
// types, where it runs, how many at once, rotating the private URL, the
// delivery log — stays one "Advanced options" away on each trigger.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Copy, ExternalLink, Laptop, Cloud, Link2, Loader2, Pencil, RotateCw, Trash2, Webhook, X, Zap } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { WEBHOOK_DEFAULT_MAX_PENDING_RUNS, webhookActivationDefaults, type WebhookTrigger, type WebhookTriggerInput } from "@/lib/webhooks";
import { api, useStore, type Bot } from "@/state/store";

import { Switch } from "./SettingsPrimitives";
import {
  WebhookEditor,
  outcomeLabel,
  outcomeTone,
  relativeTime,
  statusFor,
  suggestedName,
  terminalCommand,
  useWebhookActions,
  webhookActivity,
} from "./WebhooksPanel";

/** What can start a trigger. Picking one only names the trigger: every
 * source is the same private URL underneath. Brand names stay as written. */
export const TRIGGER_SOURCES: Array<{ id: string; labelKey?: LocaleKey; label?: string }> = [
  { id: "link", labelKey: "triggers.source.linkRequest" },
  { id: "typeform", label: "Typeform" },
  { id: "zapier", label: "Zapier" },
  { id: "github", label: "GitHub" },
  { id: "stripe", label: "Stripe" },
  { id: "custom", labelKey: "triggers.source.custom" },
];

export function triggerSourceLabel(id: string): string {
  const source = TRIGGER_SOURCES.find((entry) => entry.id === id);
  if (!source) return "";
  return source.labelKey ? t(source.labelKey) : source.label ?? "";
}

/** The request the builder sends: exactly what the full editor sends for a
 * new webhook with its advanced options left alone. */
export function triggerInput(draft: { source: string; customName: string; botId: string; prompt: string }, bots: Bot[]): WebhookTriggerInput {
  const prompt = draft.prompt.trim();
  const named = draft.source === "custom" ? draft.customName.trim() : triggerSourceLabel(draft.source);
  return {
    name: named || suggestedName(prompt, bots.find((bot) => bot.id === draft.botId)),
    prompt,
    botId: draft.botId,
    runOn: "maus",
    ...webhookActivationDefaults(),
    eventTypes: [],
    maxPendingRuns: null,
  };
}

const selectClass =
  "min-h-9 max-w-full rounded-xl border border-hairline/40 bg-control/70 px-3 py-1.5 text-[13.5px] font-medium text-ink focus:border-focus";

export function TriggersPanel() {
  const { state, dispatch } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden);
  const dialogRef = useRef<HTMLDivElement>(null);
  const actions = useWebhookActions();
  const { credentials, working, copiedId, copiedKind, error, setError, invoke, createAndCopyCommand, rememberCredential } = actions;
  const [source, setSource] = useState("link");
  const [customName, setCustomName] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebhookTrigger | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing !== null;
  const close = () => dispatch({ type: "toggleTriggers", open: false });
  const ingress = state.webhookIngress;
  const chosenBot = bots.some((bot) => bot.id === botId) ? botId : bots[0]?.id ?? "";

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    (dialog?.querySelector<HTMLElement>("select") ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // The full editor, when open, owns Escape and its own focus trap.
      if (event.defaultPrevented || editingRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleTriggers", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [dispatch]);

  const create = async () => {
    if (!chosenBot || creating) return;
    setCreating(true);
    setError("");
    try {
      const response = await api("/api/webhooks", {
        method: "POST",
        body: JSON.stringify(triggerInput({ source, customName, botId: chosenBot, prompt }, bots)),
      });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      if (response.credential) rememberCredential(response.webhook.id, response.credential);
      setPrompt("");
      setCustomName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would
          stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="triggers-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex flex-col overflow-hidden rounded-[24px] outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <h2 id="triggers-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{t("triggers.title")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("triggers.subtitle")}</p>
          </div>
          <button onClick={close} aria-label={t("triggers.close")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={21} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 sm:px-8">
          {/* the builder: one sentence */}
          <form
            data-trigger-builder
            className="glass-card rounded-2xl p-4 sm:p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
              <Zap size={16} className="shrink-0 text-accent-text" aria-hidden="true" />
              <span className="font-medium">{t("triggers.when")}</span>
              <select aria-label={t("triggers.sourceAria")} value={source} onChange={(event) => setSource(event.target.value)} className={selectClass}>
                {TRIGGER_SOURCES.map((entry) => (
                  <option key={entry.id} value={entry.id}>{triggerSourceLabel(entry.id)}</option>
                ))}
              </select>
              {source === "custom" && (
                <input
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  aria-label={t("triggers.source.customAria")}
                  placeholder={t("triggers.source.customPlaceholder")}
                  maxLength={80}
                  className="min-h-9 min-w-[200px] flex-1 rounded-xl border border-hairline/40 bg-inset px-3 py-1.5 text-[13.5px] text-ink placeholder:text-ink-tertiary"
                />
              )}
              <ArrowRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
              <select aria-label={t("triggers.botAria")} value={chosenBot} disabled={bots.length === 0} onChange={(event) => setBotId(event.target.value)} className={selectClass}>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>{bot.name}</option>
                ))}
              </select>
              <span className="font-medium">{t("triggers.should")}</span>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              aria-label={t("triggers.instructionsAria")}
              placeholder={t("triggers.instructionsPlaceholder")}
              className="mt-3 w-full resize-y rounded-xl border border-hairline/40 bg-inset px-3.5 py-3 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-tertiary"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              {bots.length === 0 ? <p className="text-[12px] text-warning">{t("triggers.noBots")}</p> : <span />}
              <button
                type="submit"
                disabled={creating || !chosenBot}
                className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
              >
                {creating && <Loader2 size={14} className="animate-spin" />}
                {t("triggers.create")}
              </button>
            </div>
          </form>

          {error && <div role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
          {ingress && !ingress.available && (
            <div role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">
              <span className="size-1.5 shrink-0 rounded-full bg-danger" />{t("triggers.receiverUnavailable")}{ingress.error ? ` ${ingress.error}` : ""}
            </div>
          )}

          <section aria-labelledby="triggers-yours" className="mt-7">
            <div className="mb-2 flex items-center justify-between">
              <h3 id="triggers-yours" className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t("triggers.yours")}</h3>
              <span className="text-[11px] tabular-nums text-ink-tertiary">{state.webhooks.length}</span>
            </div>
            {state.webhooks.length === 0 ? (
              <div className="glass-card rounded-2xl px-5 py-8 text-center text-[12.5px] text-ink-secondary">{t("triggers.empty")}</div>
            ) : (
              <ul className="space-y-2">
                {state.webhooks.map((webhook) => (
                  <TriggerRow
                    key={webhook.id}
                    webhook={webhook}
                    bot={state.bots.find((candidate) => candidate.id === webhook.botId)}
                    hasCredential={Boolean(credentials[webhook.id])}
                    command={credentials[webhook.id] ? terminalCommand(credentials[webhook.id]!) : ""}
                    working={working}
                    copied={copiedId === webhook.id ? copiedKind : null}
                    ingressAvailable={ingress?.available !== false}
                    onToggle={() => void invoke(webhook, "toggle")}
                    onDelete={() => void invoke(webhook, "delete")}
                    onCopy={(copy, replace) => void createAndCopyCommand(webhook, replace, copy)}
                    onEdit={() => setEditing(webhook)}
                    onOpenChat={(threadId) => {
                      close();
                      dispatch({ type: "select", id: webhook.botId });
                      dispatch({ type: "switchTask", botId: webhook.botId, threadId });
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {editing && (
        <WebhookEditor
          webhook={editing}
          bots={bots}
          onClose={() => setEditing(null)}
          onCredential={(credential, webhookId) => rememberCredential(webhookId, credential)}
        />
      )}
    </div>
  );
}

function TriggerRow({
  webhook,
  bot,
  hasCredential,
  command,
  working,
  copied,
  ingressAvailable,
  onToggle,
  onDelete,
  onCopy,
  onEdit,
  onOpenChat,
}: {
  webhook: WebhookTrigger;
  bot: Bot | undefined;
  hasCredential: boolean;
  command: string;
  working: string | null;
  copied: "command" | "link" | null;
  ingressAvailable: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onCopy: (copy: "command" | "link", replace: boolean) => void;
  onEdit: () => void;
  onOpenChat: (threadId: string) => void;
}) {
  const { state } = useStore();
  const status = statusFor(webhook);
  const activity = useMemo(
    () => webhookActivity(webhook, state.webhookAttempts, state.routineRuns),
    [webhook, state.webhookAttempts, state.routineRuns],
  );
  const busy = working !== null;
  // Turning on before the first test request is refused by the server too.
  const waitingForTest = Boolean(webhook.verificationPending && !webhook.enabled);
  const botName = bot?.name ?? t("triggers.deletedBot");
  return (
    <li data-trigger-row={webhook.id} className="glass-card rounded-2xl">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        {bot ? (
          <BotAvatar bot={bot} state={webhook.enabled ? "idle" : "sleeping"} size={34} animated={false} label={bot.name} />
        ) : (
          <div className="flex size-[34px] shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary"><Webhook size={16} /></div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium text-ink">
            <span className="truncate">{webhook.name}</span>
            <ArrowRight size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
            <span className="truncate">{botName}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-secondary">
            <span className={cn("size-1.5 rounded-full", status.dot)} />
            <span className={status.tone}>{status.label}</span>
            <span aria-hidden="true">·</span>
            <span>
              {webhook.lastReceivedAt
                ? t("triggers.received", { count: webhook.deliveryCount, when: relativeTime(webhook.lastReceivedAt) })
                : t("triggers.neverReceived")}
            </span>
          </div>
        </div>
        <button
          type="button"
          disabled={busy || (!hasCredential && !ingressAvailable)}
          onClick={() => onCopy("link", false)}
          className="flex items-center gap-1.5 rounded-lg bg-control/70 px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {copied === "link" ? <Check size={13} className="text-success" /> : working === `${webhook.id}:command` ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
          {copied === "link" ? t("triggers.copied") : t("triggers.copyLink")}
        </button>
        <Switch
          checked={webhook.enabled}
          disabled={busy || waitingForTest}
          title={waitingForTest ? t("triggers.waitingTest") : undefined}
          aria-label={t("triggers.toggleAria", { name: webhook.name })}
          onClick={onToggle}
        />
      </div>
      <details className="group border-t border-hairline/25 px-4 py-2.5">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary hover:text-ink">{t("triggers.advanced")}</summary>
        <div className="mt-3 space-y-3 pb-2 text-[11.5px] leading-relaxed text-ink-secondary">
          <div className="rounded-xl border border-accent-border/30 bg-inset/60 px-3 py-2.5">
            {t("triggers.requestTask")} <code className="text-ink">{JSON.stringify({ task: t("triggers.sampleTask") })}</code>. {t("triggers.keepsSetup")}
          </div>
          {webhook.prompt ? <p><span className="font-medium text-ink">{t("triggers.defaultInstruction")}</span> {webhook.prompt}</p> : <p>{t("triggers.requestInstruction")}</p>}
          {webhook.eventTypes?.length ? <p><span className="font-medium text-ink">{t("triggers.acceptedEvents")}</span> {webhook.eventTypes.join(", ")}</p> : <p>{t("triggers.allEvents")}</p>}
          <p className="flex items-center gap-1.5">
            {webhook.runOn === "cloud" ? <Cloud size={12} /> : <Laptop size={12} />}
            <span className="font-medium text-ink">{t("routines.drawer.runsOn")}:</span> {t(webhook.runOn === "cloud" ? "triggers.cloudVm" : "routines.runsOn.local")}
          </p>
          <p><span className="font-medium text-ink">{t("triggers.pendingTasks")}</span> {t("triggers.pendingTasksHelp", { count: webhook.maxPendingRuns ?? WEBHOOK_DEFAULT_MAX_PENDING_RUNS })}</p>
          {hasCredential && (
            <pre className="overflow-x-auto rounded-xl bg-inset p-3 font-mono text-[10.5px] whitespace-pre-wrap break-all text-ink-secondary">{command}</pre>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || (!hasCredential && !ingressAvailable)} onClick={() => onCopy("command", false)} className="flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-raised disabled:opacity-40">
              {copied === "command" ? <Check size={12} className="text-success" /> : <Copy size={12} />}{t(copied === "command" ? "triggers.copied" : "engineSetup.copyCommand")}
            </button>
            <button type="button" disabled={busy || !ingressAvailable} onClick={() => onCopy("link", true)} className="flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-raised disabled:opacity-40">
              <RotateCw size={12} />{t("triggers.rotateUrl")}
            </button>
            <button type="button" disabled={busy} onClick={onEdit} className="flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-raised disabled:opacity-40">
              <Pencil size={12} />{t("triggers.editSettings")}
            </button>
            <button type="button" disabled={busy} onClick={onDelete} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40">
              <Trash2 size={12} />{t("common.delete")}
            </button>
          </div>
          <div>
            <div className="mb-1 font-medium text-ink">{t("triggers.recentDeliveries")}</div>
            {activity.length === 0 ? (
              <p>{t("triggers.noRequests")}</p>
            ) : (
              <ul className="divide-y divide-hairline/25">
                {activity.slice(0, 8).map((item) => (
                  <li key={item.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5"><span className="truncate font-medium text-ink">{item.eventName}</span><span className="shrink-0">· {relativeTime(item.at)}</span></div>
                      <div className="truncate font-mono text-[10px] text-ink-tertiary">{item.reason || item.preview || t("triggers.emptyPayload")}</div>
                    </div>
                    <span className={cn("shrink-0 text-[10.5px] font-medium", outcomeTone(item.outcome, item.run))}>{outcomeLabel(item.outcome, item.run)}</span>
                    {item.run?.threadId && bot && (
                      <button type="button" onClick={() => onOpenChat(item.run!.threadId!)} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] hover:bg-raised hover:text-ink">
                        <ExternalLink size={11} />{t("canvas.openChat")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}
