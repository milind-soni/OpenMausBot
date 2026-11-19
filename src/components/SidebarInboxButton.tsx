import { ELEVATED_CONTROL, ELEVATED_OPEN, ELEVATED_TINT } from "./elevated";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeInbox, openInbox, useInboxPanel, useInboxSupport, useInboxView } from "@/state/inbox";
import { useStore } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";
import { inboxFixes, waitingCount } from "./inbox/inbox-view";
import { inboxAttentionEntries, unreadConversations } from "./inbox/InboxActive";

export function SidebarInboxButton({ className, onOpened }: { className?: string; onOpened?: () => void }) {
  const support = useInboxSupport();
  const view = useInboxView();
  const { state } = useStore();
  const team = useTeamPeople();
  const { open } = useInboxPanel();
  if (support === "no") return null;
  const count = waitingCount(view) + inboxFixes(team?.needsYou, view).length + unreadConversations(inboxAttentionEntries(state, view), view);
  const label = count > 0 ? t("inbox.row.count", { count }) : t("inbox.panel.title");
  const toggle = () => {
    if (open) closeInbox();
    else { openInbox(); onOpened?.(); }
  };
  return (
    <button type="button" data-sidebar-inbox="" aria-label={label} title={label} aria-pressed={open} onClick={toggle}
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", ELEVATED_CONTROL, ELEVATED_TINT, open && cn(ELEVATED_OPEN, "text-ink"), className)}>
      <Inbox size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
