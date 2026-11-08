// The one Inbox row at the top of the sidebar, on every plan and with no account: shaped like a bot's row, with what waits
// on the person as its count and a dot while any bot is at work. It stays when nothing waits, with no count.
import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeInbox, openInbox, useInboxPanel, useInboxSupport, useInboxView } from "@/state/inbox";
import { useTeamPeople } from "@/state/team-people";
import { inboxFixes, waitingCount } from "./inbox/inbox-view";

export function SidebarInboxRow({ icons, large, running, onOpened }: {
  icons: boolean;
  /** Simple's row, sized as its bots' rows are. */
  large: boolean;
  running: boolean;
  onOpened?: () => void;
}) {
  const support = useInboxSupport();
  const view = useInboxView();
  const team = useTeamPeople();
  const { open } = useInboxPanel();
  if (support === "no") return null;
  const count = waitingCount(view) + inboxFixes(team?.needsYou, view).length;
  const shown = count > 9 ? "9+" : String(count);
  const label = count > 0 ? t("inbox.row.count", { count }) : t("inbox.panel.title");
  const toggle = () => {
    if (open) closeInbox();
    else { openInbox(); onOpened?.(); }
  };
  const dot = running && <span data-inbox-running="" aria-hidden="true" className={cn("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-panel bg-success", icons ? "size-3" : "size-2.5")} />;
  if (icons) {
    return (
      <button type="button" data-sidebar-inbox={count} aria-label={label} title={label} aria-pressed={open} onClick={toggle}
        className={cn("relative mx-auto mb-1 flex size-[46px] shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", open && "bg-raised text-ink")}>
        <Inbox size={20} strokeWidth={1.5} aria-hidden="true" />
        {count > 0 && <span aria-hidden="true" data-inbox-count className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-warning px-0.5 text-[10px] font-semibold leading-4 text-panel">{shown}</span>}
        {dot}
      </button>
    );
  }
  return (
    <div className="px-3 pb-1">
      <button type="button" data-sidebar-inbox={count} aria-label={label} title={label} aria-pressed={open} onClick={toggle}
        className={cn("flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-accent/60", open && "bg-raised/60")}>
        <span className={cn("relative grid shrink-0 place-items-center rounded-full bg-raised text-ink-secondary", large ? "size-9" : "size-8")}>
          <Inbox size={large ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />
          {dot}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-ink", large ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5")}>{t("inbox.panel.title")}</span>
        {count > 0 && <span aria-hidden="true" data-inbox-count className="shrink-0 rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular-nums text-panel">{shown}</span>}
      </button>
    </div>
  );
}
