// The editor for an automation that runs when another app sends something: who does it and what it does, with the
// rest under More. The words a person sees never say webhook, endpoint or payload.
import { useRef, useState } from "react";
import { Cloud, Laptop, Loader2, X } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { boatCapableEngine } from "@/lib/remote-desktop";
import type { RoutineRunOn } from "@/lib/routines";
import { WEBHOOK_DEFAULT_MAX_PENDING_RUNS, WEBHOOK_MAX_PENDING_RUNS_LIMIT, webhookActivationDefaults, webhookMaxPendingRunsInput, type WebhookCredential, type WebhookTrigger, type WebhookTriggerInput } from "@/lib/webhooks";
import { api, useStore, type Bot } from "@/state/store";

/** A name when the person gives none: the instructions' first words, or the bot's. */
export function suggestedName(prompt: string, bot?: Bot) {
  const first = prompt.trim().split(/[.!?\n]/)[0]?.trim().slice(0, 60);
  return first || `${bot?.name ?? "Bot"} automation`;
}

const FIELD = "w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/70";

export function WebhookEditor({ webhook, bots, initialBotId, onClose, onCredential }: { webhook?: WebhookTrigger; bots: Bot[]; initialBotId?: string; onClose: () => void; onCredential: (credential: WebhookCredential, webhookId: string) => void }) {
  const { state, dispatch } = useStore();
  const [botId, setBotId] = useState(webhook?.botId ?? (initialBotId && bots.some((bot) => bot.id === initialBotId) ? initialBotId : bots[0]?.id) ?? "");
  const [name, setName] = useState(webhook?.name ?? "");
  const [prompt, setPrompt] = useState(webhook?.prompt ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(webhook?.runOn ?? "maus");
  const [eventTypes, setEventTypes] = useState((webhook?.eventTypes ?? []).join(", "));
  const [maxPendingRuns, setMaxPendingRuns] = useState(webhook?.maxPendingRuns?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  const cloudReady = Boolean(state.config?.box.configured && boatCapableEngine(state.instances, bots.find((bot) => bot.id === botId)?.modelSelection.instanceId)?.snapshot.state === "available");

  const save = async () => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const pendingLimit = webhookMaxPendingRunsInput(maxPendingRuns);
    if (pendingLimit === undefined) {
      setError(t("automations.editor.app.limitError", { max: WEBHOOK_MAX_PENDING_RUNS_LIMIT }));
      return;
    }
    const input: WebhookTriggerInput = { name: name.trim() || suggestedName(prompt, bot), prompt: prompt.trim(), botId, runOn, ...webhookActivationDefaults(webhook), eventTypes: eventTypes.split(",").map((value) => value.trim()).filter(Boolean), maxPendingRuns: pendingLimit };
    setSaving(true);
    setError("");
    try {
      const response = await api(webhook ? `/api/webhooks/${webhook.id}` : "/api/webhooks", { method: webhook ? "PATCH" : "POST", body: JSON.stringify(input) });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      onClose();
      if (response.credential) onCredential(response.credential, response.webhook.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={webhook ? t("automations.editor.app.editTitle") : t("automations.editor.app.title")} tabIndex={-1} className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4">
          <div>
            <div className="text-[17px] font-semibold text-ink">{webhook ? t("automations.editor.app.editTitle") : t("automations.editor.app.title")}</div>
            <div className="mt-1 text-[12px] text-ink-secondary">{t("automations.editor.app.subtitle")}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("automations.newBox.cancel")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div>
            <div className="mb-2 text-[13px] font-medium text-ink">{t("automations.editor.app.who")}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{bots.map((bot) => (
              <button key={bot.id} type="button" onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}>
                <BotAvatar bot={bot} state={botId === bot.id ? "happy" : "idle"} size={32} animated={false} /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{bot.name}</span>
              </button>
            ))}</div>
          </div>
          <label className="block">
            <span className="mb-2 block text-[13px] font-medium text-ink">{t("automations.editor.app.what")}</span>
            <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder={t("automations.editor.app.whatPlaceholder")} className={cn(FIELD, "resize-y py-3 leading-relaxed")} />
          </label>
          <details className="rounded-xl border border-hairline/45 bg-inset/45 px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium text-ink">{t("automations.more")}</summary>
            <div className="mt-4 space-y-4">
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">{t("automations.editor.app.name")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={suggestedName(prompt, bots.find((bot) => bot.id === botId))} className={FIELD} /></label>
              <div>
                <div className="mb-2 text-[12px] font-medium text-ink-secondary">{t("automations.editor.app.runOn")}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRunOn("maus")} className={cn("flex items-center gap-2 rounded-xl border p-3 text-left text-[13px] font-medium text-ink", runOn === "maus" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-panel hover:bg-raised/60")}><Laptop size={14} />{t("automations.editor.app.thisComputer")}</button>
                  <button type="button" disabled={!cloudReady && runOn !== "cloud"} onClick={() => setRunOn("cloud")} className={cn("flex items-center gap-2 rounded-xl border p-3 text-left text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-panel hover:bg-raised/60")}><Cloud size={14} />{t("automations.editor.app.cloud")}</button>
                </div>
              </div>
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">{t("automations.editor.app.events")}</span><input value={eventTypes} onChange={(event) => setEventTypes(event.target.value)} placeholder="push, workflow_run" className={FIELD} /><span className="mt-1.5 block text-[11px] text-ink-secondary">{t("automations.editor.app.eventsHelp")}</span></label>
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">{t("automations.editor.app.limit")}</span><input type="number" inputMode="numeric" min={1} max={WEBHOOK_MAX_PENDING_RUNS_LIMIT} step={1} value={maxPendingRuns} onChange={(event) => setMaxPendingRuns(event.target.value)} placeholder={String(WEBHOOK_DEFAULT_MAX_PENDING_RUNS)} className={FIELD} /><span className="mt-1.5 block text-[11px] text-ink-secondary">{t("automations.editor.app.limitHelp", { count: WEBHOOK_DEFAULT_MAX_PENDING_RUNS })}</span></label>
            </div>
          </details>
          {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">{t("automations.newBox.cancel")}</button>
          <button type="button" disabled={saving || !botId} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{webhook ? t("automations.editor.app.save") : t("automations.editor.app.create")}</button>
        </div>
      </div>
    </div>
  );
}
