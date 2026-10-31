import { useEffect, useRef, useState } from "react";
import { api, useStore, type Bot, type ModelSelection } from "@/state/store";
import { announceNewBot } from "@/lib/new-bot";
import { modelChoices } from "@/lib/model-choices";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { Loader2, X } from "lucide-react";
import { Select } from "./Select";

export function RemoteNewBotDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending.current) { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>("select:not(:disabled), button:not(:disabled)") ?? [])];
      if (!items.length) return;
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === dialog.current)) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("keydown", keys); if (previous?.isConnected) previous.focus(); };
  }, []);
  const choices = state.instances.filter(instance => instance.snapshot.state === "available" && !instance.policy)
    .flatMap(instance => modelChoices(instance, instance.models.options.filter(option => instance.snapshot.authenticated !== false || option.custom)).map(choice => ({
      label: `${instance.displayName} · ${choice.label}`,
      selection: { instanceId: instance.instanceId, model: choice.nativeModel ?? choice.id,
        ...(choice.variant ? { variant: choice.variant } : {}) } as ModelSelection,
    })));
  const create = async () => {
    if (pending.current) return;
    const choice = choices.find(item => JSON.stringify(item.selection) === selected);
    if (selected && !choice) { setError(t("newBot.remoteModelUnavailable")); return; }
    pending.current = true; setSaving(true); setError("");
    try {
      const { bot } = await api<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify(
        choice ? { modelSelection: choice.selection, requireAvailableModel: true } : {},
      ) });
      announceNewBot(dispatch, bot, [], { showThreads, source: "blank" });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { pending.current = false; setSaving(false); }
  };
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-busy={saving} aria-labelledby="remote-new-bot-title" tabIndex={-1} className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none">
      <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
        <h2 id="remote-new-bot-title" className="text-[17px] font-semibold text-ink">{t("sidebar.newBot")}</h2>
        <button type="button" onClick={onClose} disabled={saving} aria-label={t("common.close")} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"><X size={18} /></button>
      </div>
      <label className="block px-5 py-4 text-[13px] text-ink-secondary">{t("model.section.default")}
        <Select value={selected} onChange={event => setSelected(event.target.value)} disabled={saving} className="mt-2 w-full">
          <option value="">{t("newBot.remoteDefaultModel")}</option>
          {choices.map(choice => <option key={JSON.stringify(choice.selection)} value={JSON.stringify(choice.selection)}>{choice.label}</option>)}
        </Select>
      </label>
      {error && <p role="alert" className="max-h-24 overflow-y-auto border-t border-hairline/40 px-5 py-3 text-[13px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-3">
        <button type="button" onClick={onClose} disabled={saving} className="rounded-lg px-4 py-2 text-[13px] text-ink-secondary hover:bg-control disabled:opacity-40">{t("common.cancel")}</button>
        <button type="button" onClick={() => void create()} disabled={saving} className="ui-button-primary flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={15} className="animate-spin" />}{t("newBot.create")}</button>
      </div>
    </div>
  </div>;
}
