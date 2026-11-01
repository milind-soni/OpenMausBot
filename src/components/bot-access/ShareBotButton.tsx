import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Share } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { saveAccess } from "./access";
import { ShareBotDialog, type AccessChange } from "./ShareBotDialog";

const TOAST_MS = 6_000;

/** The team's name, or null anywhere but a team. */
export function useTeamName(): string | null {
  const { state } = useStore();
  const team = (state.config as { team?: { name?: unknown } } | null | undefined)?.team;
  return typeof team?.name === "string" && team.name ? team.name : null;
}

/** A bot's Share button on a team: opens who has access. `footer` holds what else the button offers there. */
export function ShareBotButton({ bot, className, footer, iconSize = 16 }: { bot: Bot; className: string; footer?: ReactNode; iconSize?: number }) {
  const teamName = useTeamName();
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<AccessChange | null>(null);
  const settled = useCallback(() => setChange(null), []);
  if (!teamName) return null;
  return (
    <>
      <button type="button" data-panel-share data-share-bot-button aria-label={t("botAccess.share")} title={t("botAccess.share")}
        aria-haspopup="dialog" onClick={() => setOpen(true)} className={className}>
        <Share size={iconSize} aria-hidden="true" className="pointer-events-none" />
      </button>
      {open && <ShareBotDialog bot={bot} teamName={teamName} onClose={() => setOpen(false)} onChanged={setChange} footer={footer} />}
      {change && <UndoToast key={`${change.text}:${JSON.stringify(change.after)}`} text={change.text}
        onUndo={() => saveAccess(bot.id, change.before)} onDone={settled} />}
    </>
  );
}

/** "Bob can now chat · Undo", for a few seconds; Undo puts the sharing back as it was. */
export function UndoToast({ text, onUndo, onDone }: { text: string; onUndo: () => Promise<unknown>; onDone: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(onDone, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return createPortal(
    <div role="status" data-access-toast className="fixed bottom-5 left-1/2 z-[70] flex max-w-[min(420px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-hairline/50 bg-card px-3.5 py-2.5 text-[13px] text-ink shadow-xl">
      <span className="min-w-0 flex-1">{failed ? t("botAccess.undoFailed") : text}</span>
      {!failed && (
        <button type="button" onClick={() => void onUndo().then(onDone, () => setFailed(true))} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised">
          {t("common.undo")}
        </button>
      )}
    </div>,
    document.body,
  );
}
