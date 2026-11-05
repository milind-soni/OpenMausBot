// Under the inbox's lines: what else is going on, each opening where it is. What a team's person has to fix, and the
// conversations at work, with the pin that keeps them open in the sidebar.
import { Pin, PinOff } from "lucide-react";
import type { InboxView } from "../../../shared/inbox";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";
import { AttentionThreadRows, attentionJumpAction, crossBotAttentionThreads } from "../SidebarBotActivity";
import { NeedsYouLine } from "../TeamOwner";
import { setAttentionPinned, useAttentionPinned } from "./attention-pinned";
import { closeInbox } from "@/state/inbox";
import { inboxFixes } from "./inbox-view";

export function InboxActive({ view }: { view: InboxView | null }) {
  const { state, dispatch } = useStore();
  const team = useTeamPeople();
  const pinned = useAttentionPinned();
  const rows = view?.rows ?? [];
  const asked = new Set(rows.filter((row) => row.tab === "needs-you").map((row) => row.origin?.threadId));
  const news = new Set(rows.filter((row) => row.tab === "info").map((row) => row.origin?.threadId));
  const atWork = (task: { busy?: boolean; activity?: string; queued?: boolean }) => task.busy === true || task.activity === "working" || task.queued === true;
  const entries = crossBotAttentionThreads(state.bots, state.pendingQueued, undefined, state.groups)
    .filter((entry) => !asked.has(entry.task.threadId) && (atWork(entry.task) || !news.has(entry.task.threadId)));
  const fixes = inboxFixes(team?.needsYou, view);
  return (
    <>
      {fixes.length > 0 && (
        <section data-inbox-fixes className="border-t border-hairline/40 px-1.5 py-1.5">
          {fixes.map((item) => <NeedsYouLine key={`${item.kind}:${item.id}`} item={item} onOpened={closeInbox} />)}
        </section>
      )}
      {(entries.length > 0 || pinned) && (
        <section data-inbox-active aria-label={t("attention.title")} className="border-t border-hairline/40 px-1.5 py-1.5">
          <div className="flex items-center gap-1 px-2 py-0.5">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-secondary">{t("attention.title")}</span>
            <button type="button" data-inbox-pin onClick={() => setAttentionPinned(!pinned)} aria-label={t(pinned ? "attention.unpin" : "attention.pin")} title={t(pinned ? "attention.unpin" : "attention.pin")}
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            </button>
          </div>
          <AttentionThreadRows inset entries={entries} onJump={(entry) => dispatch(attentionJumpAction(entry))} />
        </section>
      )}
    </>
  );
}
