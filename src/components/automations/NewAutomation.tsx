import { useRef, useState } from "react";
import { AppWindow, CalendarClock, Send, Share2, X } from "lucide-react";

import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { Select } from "../Select";

export type SetUpKind = "schedule" | "webhook" | "app";

/** The bot "+ New" talks to: the one open now, else the one most recently talked to. */
export function defaultBot(bots: readonly Bot[], selectedId: string): Bot | undefined {
  const open = bots.find((bot) => bot.id === selectedId);
  if (open) return open;
  const lastAt = (bot: Bot) => bot.messages.at(-1)?.at ?? 0;
  return [...bots].sort((left, right) => lastAt(right) - lastAt(left))[0];
}

/** "+ New": say what should happen and a bot sets it up in chat, exactly as if you had asked it there. */
export function NewAutomation({ initialText = "", onClose, onSetUpYourself }: {
  initialText?: string;
  onClose: () => void;
  /** The bot this box would have asked, so the editor starts with it chosen. */
  onSetUpYourself: (kind: SetUpKind, botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden);
  const [text, setText] = useState(initialText);
  const [botId, setBotId] = useState(() => defaultBot(bots, state.selectedId)?.id ?? "");
  const [yourself, setYourself] = useState(false);
  const [kind, setKind] = useState<SetUpKind>("schedule");
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  const bot = bots.find((candidate) => candidate.id === botId);

  const send = () => {
    const request = text.trim();
    if (!request || !bot) return;
    // A normal chat message: the bot sets the automation up with create_trigger and the person sees its card there.
    dispatch({ type: "select", id: bot.id });
    dispatch({ type: "send", botId: bot.id, text: request, threadId: bot.threadId });
    onClose();
  };
  const choice = (value: SetUpKind, label: string, Icon: typeof CalendarClock) => (
    <button type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}
      className={cn("flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left text-[14px]", kind === value ? "border-accent/70 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:bg-raised")}>
      <Icon size={16} className="shrink-0 text-accent" />{label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-5 pt-[14vh] backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("automations.newBox.title")} tabIndex={-1} className="w-full max-w-[560px] rounded-2xl border border-hairline/60 bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-ink">{yourself ? t("automations.newBox.when") : t("automations.newBox.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("automations.newBox.cancel")} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><X size={16} /></button>
        </div>
        {yourself ? (
          <>
            <div role="radiogroup" aria-label={t("automations.newBox.when")} className="mt-4 space-y-2">
              {choice("schedule", t("automations.newBox.onSchedule"), CalendarClock)}
              {choice("app", t("automations.newBox.whenAppEvent"), AppWindow)}
              {choice("webhook", t("automations.newBox.whenApp"), Share2)}
            </div>
            <div className="mt-5 flex items-center justify-between gap-2">
              <button type="button" onClick={() => setYourself(false)} className="rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">{t("automations.newBox.back")}</button>
              <button type="button" onClick={() => onSetUpYourself(kind, bot?.id ?? "")} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110">{t("automations.newBox.continue")}</button>
            </div>
          </>
        ) : (
          <>
            <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} rows={3} placeholder={t("automations.newBox.placeholder")}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
              className="mt-4 w-full resize-none rounded-xl border border-hairline/60 bg-inset px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/70" />
            {bots.length === 0 && <p className="mt-2 text-[13px] text-warning">{t("automations.newBox.noBots")}</p>}
            {bots.length > 1 && (
              <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
                {t("automations.newBox.bot")}
                <Select size="sm" value={botId} onChange={(event) => setBotId(event.target.value)} aria-label={t("automations.newBox.bot")} className="max-w-[220px]">
                  {bots.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                </Select>
              </label>
            )}
            <div className="mt-4 flex items-center justify-between gap-2">
              <button type="button" onClick={() => setYourself(true)} className="rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline">{t("automations.newBox.yourself")}</button>
              <button type="button" disabled={!text.trim() || !bot} onClick={send} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"><Send size={14} />{t("automations.newBox.send")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
