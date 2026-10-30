// One line of the person's inbox as a dense row: the sender's face and name, the subject, a muted snippet and the time.
// An unread row is bold on a stronger ground. On hover or keyboard focus the time gives way to the row's quick actions.
import { Check, CornerUpLeft, ExternalLink, X, type LucideIcon } from "lucide-react";
import type { InboxRow } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { InboxSender } from "../InboxLine";
import { threadUpdatedLabel } from "../SidebarThreadRow";
import { quickActions, subjectOf, type QuickAction } from "./inbox-view";

const ACTION_LOOK: Record<QuickAction, { Icon: LucideIcon; label: LocaleKey }> = {
  allow: { Icon: Check, label: "approval.action.allowOnce" },
  deny: { Icon: X, label: "approval.action.deny" },
  reply: { Icon: CornerUpLeft, label: "chat.reply" },
  close: { Icon: Check, label: "common.done" },
  done: { Icon: Check, label: "common.done" },
  open: { Icon: ExternalLink, label: "inbox.action.openInChat" },
};

const ROW_ACTION = "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink active:bg-ink/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:size-9";

export function InboxRowItem({ row, now, onOpen, onAction, inCard = false }: {
  row: InboxRow;
  now: number;
  onOpen(row: InboxRow): void;
  onAction(row: InboxRow, action: QuickAction): void;
  /** On the inbox's card in the chat, which is wider than the panel and draws its own dividers. */
  inCard?: boolean;
}) {
  const subject = subjectOf(row);
  const actions = quickActions(row);
  return (
    <div data-inbox-row={row.id} data-tab={row.tab} data-unread={row.unread ? "" : undefined}
      className={cn("group relative flex min-w-0 items-center gap-2 border-b border-hairline/20 pr-1.5 focus-within:bg-raised/70 hover:bg-raised/70",
        row.unread ? "bg-raised/45" : "bg-transparent", inCard && "border-b-0")}>
      <button type="button" onClick={() => onOpen(row)} title={`${row.from.name} · ${subject}`}
        className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
          row.unread ? "font-semibold text-ink" : "font-normal text-ink-secondary")}>
        <span className="shrink-0" aria-hidden="true"><InboxSender from={row.from} size={20} /></span>
        <span className={cn("shrink-0 truncate", inCard ? "w-[7.5rem]" : "w-[5.5rem] sm:w-[6.5rem]")}>{row.from.name}</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="max-w-[45%] shrink-0 truncate">{subject}</span>
          <span className="min-w-0 truncate font-normal text-ink-tertiary">{row.text}</span>
        </span>
        <span className="shrink-0 text-[11px] font-normal tabular-nums text-ink-tertiary group-focus-within:invisible group-hover:invisible">{threadUpdatedLabel(row.at, now)}</span>
      </button>
      <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-raised group-focus-within:flex group-hover:flex">
        {actions.map((action) => {
          const { Icon, label } = ACTION_LOOK[action];
          return (
            <button key={action} type="button" data-inbox-action={action} aria-label={t(label)} title={t(label)} onClick={() => onAction(row, action)} className={ROW_ACTION}>
              <Icon size={14} aria-hidden="true" />
            </button>
          );
        })}
      </span>
    </div>
  );
}
