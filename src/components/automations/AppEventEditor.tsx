// "When something happens in an app": pick the bot, the app and what happens in it, a few plain filters, and what the
// bot does. Only connected apps the chosen bot may use are offered.
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { appTriggerApi, type AppEventCatalog, type AppTrigger, type AppTriggerFilter } from "@/lib/app-triggers";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { Select } from "../Select";
import { suggestedName } from "../WebhookTrigger";

const FIELD = "w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/70";
const LABEL = "mb-1.5 block text-[12px] font-medium text-ink-secondary";

export function AppEventEditor({ trigger, bots, initialBotId, onClose, onSaved }: { trigger?: AppTrigger; bots: Bot[]; initialBotId?: string; onClose: () => void; onSaved?: (trigger: AppTrigger) => void }) {
  const { dispatch } = useStore();
  const [botId, setBotId] = useState(trigger?.botId ?? (initialBotId && bots.some((bot) => bot.id === initialBotId) ? initialBotId : bots[0]?.id) ?? "");
  const [catalog, setCatalog] = useState<AppEventCatalog | null>(null);
  const [app, setApp] = useState(trigger?.app ?? "");
  const [event, setEvent] = useState(trigger?.event ?? "");
  const [account, setAccount] = useState(trigger?.accountId ?? "");
  const [filter, setFilter] = useState<AppTriggerFilter>(trigger?.filter ?? {});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState(trigger?.prompt ?? "");
  const [name, setName] = useState(trigger?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);

  useEffect(() => {
    if (trigger || !botId) return;
    let alive = true;
    setCatalog(null);
    appTriggerApi.events(botId)
      .then((next) => {
        if (!alive) return;
        setCatalog(next);
        const first = next.apps.find((candidate) => candidate.events.length);
        setApp((current) => next.apps.some((candidate) => candidate.app === current) ? current : first?.app ?? "");
      })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [botId, trigger]);

  const appEntry = catalog?.apps.find((candidate) => candidate.app === app);
  const events = appEntry?.events ?? [];
  const chosen = events.find((candidate) => candidate.event === event) ?? (trigger ? undefined : events[0]);
  useEffect(() => {
    if (!trigger && chosen && chosen.event !== event) setEvent(chosen.event);
  }, [chosen, event, trigger]);
  const required = (chosen?.configFields ?? []).filter((field) => field.required);
  const gmail = app === "gmail";
  const delivery = trigger?.delivery ?? chosen?.delivery;

  const save = async () => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const cleanFilter = Object.fromEntries(Object.entries(filter).filter(([, value]) => typeof value === "string" && value.trim())) as AppTriggerFilter;
    setSaving(true);
    setError("");
    try {
      const saved = trigger
        ? await appTriggerApi.update(trigger.id, { name: name.trim() || trigger.name, prompt: prompt.trim(), filter: Object.keys(cleanFilter).length ? cleanFilter : null })
        : await appTriggerApi.create({
          botId, app, event: chosen?.event ?? event, prompt: prompt.trim(), name: name.trim() || suggestedName(prompt, bot),
          ...(account ? { account } : {}), ...(Object.keys(cleanFilter).length ? { filter: cleanFilter } : {}),
          ...(Object.keys(config).length ? { config } : {}),
        });
      onSaved?.(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const filterField = (key: keyof AppTriggerFilter, label: string, placeholder: string) => (
    <label className="block" key={key}>
      <span className={LABEL}>{label}</span>
      <input value={filter[key] ?? ""} onChange={(input) => setFilter((current) => ({ ...current, [key]: input.target.value }))} placeholder={placeholder} className={FIELD} />
    </label>
  );
  const title = trigger ? t("automations.editor.app.editTitle") : t("automations.editor.appEvent.title");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm" onMouseDown={(click) => click.target === click.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4">
          <div className="text-[17px] font-semibold text-ink">{title}</div>
          <button type="button" onClick={onClose} aria-label={t("automations.newBox.cancel")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {!trigger && (
            <div>
              <div className="mb-2 text-[13px] font-medium text-ink">{t("automations.editor.app.who")}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{bots.map((bot) => (
                <button key={bot.id} type="button" onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}>
                  <BotAvatar bot={bot} state={botId === bot.id ? "happy" : "idle"} size={32} animated={false} /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{bot.name}</span>
                </button>
              ))}</div>
            </div>
          )}
          {!trigger && !catalog && !error && <p className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("automations.editor.appEvent.loading")}</p>}
          {!trigger && catalog && (catalog.unavailable || !catalog.apps.some((candidate) => candidate.events.length)) && (
            <div className="rounded-xl border border-hairline/45 bg-inset/50 p-3.5 text-[13px] text-ink-secondary">
              <p>{catalog.unavailable ?? t("automations.editor.appEvent.noApps")}</p>
              {!catalog.unavailable && <button type="button" onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })} className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:brightness-110">{t("automations.editor.appEvent.connect")}</button>}
            </div>
          )}
          {!trigger && catalog && appEntry && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>{t("automations.editor.appEvent.app")}</span>
                <Select value={app} onChange={(change) => { setApp(change.target.value); setEvent(""); setConfig({}); }} aria-label={t("automations.editor.appEvent.app")} className="w-full">
                  {catalog.apps.filter((candidate) => candidate.events.length).map((candidate) => <option key={candidate.app} value={candidate.app}>{candidate.name}</option>)}
                </Select>
              </label>
              <label className="block">
                <span className={LABEL}>{t("automations.editor.appEvent.event")}</span>
                <Select value={chosen?.event ?? ""} onChange={(change) => { setEvent(change.target.value); setConfig({}); }} aria-label={t("automations.editor.appEvent.event")} className="w-full">
                  {events.map((candidate) => <option key={candidate.event} value={candidate.event}>{candidate.name}</option>)}
                </Select>
              </label>
              {appEntry.accounts.length > 1 && (
                <label className="block sm:col-span-2">
                  <span className={LABEL}>{t("automations.editor.appEvent.account")}</span>
                  <Select value={account} onChange={(change) => setAccount(change.target.value)} aria-label={t("automations.editor.appEvent.account")} className="w-full">
                    <option value="" />
                    {appEntry.accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.alias ?? candidate.id}</option>)}
                  </Select>
                </label>
              )}
              {required.map((field) => (
                <label className="block sm:col-span-2" key={field.name}>
                  <span className={LABEL}>{field.name}</span>
                  <input value={config[field.name] ?? ""} onChange={(input) => setConfig((current) => ({ ...current, [field.name]: input.target.value }))} placeholder={field.description} className={FIELD} />
                </label>
              ))}
            </div>
          )}
          {(trigger || appEntry) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {gmail ? [
                filterField("from", t("automations.editor.appEvent.from"), "acme.com"),
                filterField("subject", t("automations.editor.appEvent.subject"), "order"),
                filterField("label", t("automations.editor.appEvent.label"), "Customers"),
              ] : filterField("text", t("automations.editor.appEvent.text"), "urgent")}
              {delivery && <p className="self-end text-[12px] text-ink-secondary sm:col-span-2">{delivery === "poll" ? t("automations.editor.appEvent.checks") : t("automations.editor.appEvent.instant")}</p>}
            </div>
          )}
          {(trigger || appEntry) && (
            <label className="block">
              <span className="mb-2 block text-[13px] font-medium text-ink">{t("automations.editor.app.what")}</span>
              <textarea value={prompt} onChange={(input) => setPrompt(input.target.value)} rows={3} placeholder={t("automations.editor.appEvent.whatPlaceholder")} className={cn(FIELD, "resize-y py-3 leading-relaxed")} />
            </label>
          )}
          {(trigger || appEntry) && (
            <details className="rounded-xl border border-hairline/45 bg-inset/45 px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-medium text-ink">{t("automations.more")}</summary>
              <label className="mt-4 block"><span className={LABEL}>{t("automations.editor.app.name")}</span><input value={name} onChange={(input) => setName(input.target.value)} placeholder={suggestedName(prompt, bots.find((bot) => bot.id === botId))} className={FIELD} /></label>
            </details>
          )}
          {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">{t("automations.newBox.cancel")}</button>
          <button type="button" disabled={saving || !botId || (!trigger && !chosen) || required.some((field) => !config[field.name]?.trim())} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{trigger ? t("automations.editor.app.save") : t("automations.editor.app.create")}</button>
        </div>
      </div>
    </div>
  );
}
