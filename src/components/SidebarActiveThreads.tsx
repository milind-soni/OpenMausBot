// For a server older than this page, which has no inbox for anyone off a team: the Active Threads button and tray.
import { Activity, Pin, PinOff } from "lucide-react";
import { useRef, useState, type Dispatch } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Action } from "@/state/store";
import { setAttentionPinned, useAttentionPinned } from "./inbox/attention-pinned";
import { MENU_SHEET } from "./menu-recipe";
import { attentionHasRunningWork, attentionJumpAction, attentionTriggerLabel, AttentionThreadRows, type AttentionThread } from "./SidebarBotActivity";
import { useMenuMotion } from "./MenuMotion";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";

export function SidebarActiveThreads({ entries, icons, phone, dispatch }: { entries: AttentionThread[]; icons: boolean; phone: boolean; dispatch: Dispatch<Action> }) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const pinned = useAttentionPinned();
  const menu = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, menu, () => setOpen(false));
  return (
    <div ref={menu} className={icons ? "relative" : "contents"}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label={attentionTriggerLabel(entries.length)} title={attentionTriggerLabel(entries.length)}
        className={cn("relative flex items-center justify-center text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          icons ? "size-[46px] shrink-0 rounded-xl" : phone ? "size-10 shrink-0 rounded-full border border-hairline bg-card text-ink" : "size-8 rounded-full")}>
        <Activity size={icons ? 20 : 18} strokeWidth={1.5} />
        {entries.length > 0 && <span className="absolute -end-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-0.5 text-[10px] font-semibold leading-4 text-ink">{entries.length > 9 ? "9+" : entries.length}</span>}
        {attentionHasRunningWork(entries) && <span data-header-activity="" className="absolute bottom-0.5 end-0.5 size-1.5 rounded-full bg-success" aria-hidden="true" />}
      </button>
      {motion.shown && (
        <div className={cn("absolute top-full z-40 mt-1 overflow-hidden", MENU_SHEET, icons ? "start-0 w-72" : "end-0 w-72 md:w-[min(288px,calc(var(--sidebar-width)_-_32px))]", motion.className)} {...motion.exitProps}>
          <div className="flex items-center gap-1 py-0.5 ps-2">
            <span className="flex-1 text-[13px] font-medium text-ink">{t("attention.title")}</span>
            <button type="button" onClick={() => setAttentionPinned(!pinned)} aria-label={t(pinned ? "attention.unpin" : "attention.pin")} title={t(pinned ? "attention.unpin" : "attention.pin")}
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-menu-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
          {entries.length === 0
            ? <div className="px-2 py-1.5 text-[13px] text-ink-secondary">{t("attention.empty")}</div>
            : <AttentionThreadRows inset entries={entries} onJump={(entry) => { setOpen(false); dispatch(attentionJumpAction(entry)); }} />}
        </div>
      )}
    </div>
  );
}
