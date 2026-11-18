import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ExternalLink, MoreHorizontal, UserRound, X } from "lucide-react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { t } from "@/lib/i18n";
import { readInboxLine } from "@/state/inbox";
import { ChatMarkdown } from "../ChatMarkdown";
import { InboxSender } from "../InboxLine";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";
import { threadUpdatedLabel } from "../SidebarThreadRow";
import { accessRequestWords } from "../bot-access/access-card";
import { InboxAnswer } from "./InboxAnswer";
import { answerKindOf, headlineOf, singleQuestion } from "./inbox-answer";
import { askOf, closeResponse, senderLabel, textOf } from "./inbox-view";
import { useAskContext } from "./use-ask-context";
import { useInboxActions } from "./use-inbox-actions";

const NAV_BUTTON = "flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-35 pointer-coarse:size-9";

function settledLabel(row: InboxRow): string {
  if (row.kind !== "ask") return t("common.done");
  const card = row.card;
  if (card?.stopped) return t("ask.settled.stopped");
  if (card?.expired) return t(card.tool ? "approval.status.expired" : "ask.settled.expired");
  if (card?.answered === "allow") return t("approval.status.allowed");
  if (card?.answered === "deny") return t("approval.status.denied");
  return card?.answered === "answer" && !card.dismissed ? t("question.status.answered") : t("question.status.closed");
}

/** What the line itself says, drawn after the bot's words before it: a question's question, news as it came. An approval,
 * a password or a sign-in says it on its own card. */
function ownWords(row: InboxRow): string | null {
  if (row.secret || row.signIn || row.connector) return null;
  if (row.kind !== "ask") return textOf(row);
  if (row.card?.tool) return null;
  const question = singleQuestion(row);
  return question ? accessRequestWords(row.card)?.question ?? question.question : row.card?.questionRequest ? null : row.card?.subtitle || row.text;
}

export function InboxReading({ view, row, now, position, onStep }: {
  view: InboxView;
  row: InboxRow;
  now: number;
  /** Where the line is in the list the person came from; null when it has left it. */
  position: { index: number; count: number } | null;
  onStep(by: -1 | 1): void;
}) {
  const { answer, openInChat, run, askerOf } = useInboxActions(view);
  const asker = askerOf(row);
  const context = useAskContext(row);
  const kind = answerKindOf(row);
  const headline = headlineOf(row);
  const words = ownWords(row);
  const said = context.filter((message) => message.text?.trim() !== words?.trim());
  const menu: SidebarMenuItem[] = [
    ...(row.origin || view.threadId ? [{ key: "open", label: t("inbox.action.openInChat"), icon: <ExternalLink size={16} />, onSelect: () => openInChat(row) }] : []),
    ...(row.tab === "info" ? [{ key: "done", label: t("common.done"), icon: <Check size={16} />, onSelect: () => run(row, "done") }] : []),
    ...(askOf(row) === "question" ? [{ key: "close", label: t("inbox.action.closeQuestion"), icon: <X size={16} />, onSelect: () => answer(row, closeResponse(row)) }] : []),
  ];
  const place = row.origin?.title || senderLabel(row);
  return (
    <article data-inbox-reading={row.id} aria-label={`${senderLabel(row)} · ${headline}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" onClick={() => readInboxLine(null)} aria-label={t("inbox.action.back")} title={t("inbox.action.back")}
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-md pe-2 ps-1 text-[13px] font-medium text-ink hover:bg-raised pointer-coarse:h-9">
          <ChevronLeft size={16} aria-hidden="true" className="rtl:rotate-180" />{t("inbox.panel.title")}
        </button>
        <span className="flex-1" />
        {position && <span data-inbox-position className="px-1 text-[12px] tabular-nums text-ink-tertiary">{t("inbox.position", { index: position.index + 1, count: position.count })}</span>}
        <button type="button" onClick={() => onStep(-1)} disabled={!position || position.index === 0} aria-label={t("inbox.action.previous")} title={t("inbox.action.previous")} className={NAV_BUTTON}>
          <ChevronUp size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onStep(1)} disabled={!position || position.index >= position.count - 1} aria-label={t("inbox.action.next")} title={t("inbox.action.next")} className={NAV_BUTTON}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {menu.length > 0 && (
          <SidebarPopoverMenu items={menu} ariaLabel={t("inbox.action.more")} placement="below" align="end" triggerClassName="rounded-md" triggerTitle={t("inbox.action.more")}
            renderTrigger={() => <span className={NAV_BUTTON}><MoreHorizontal size={16} aria-hidden="true" /></span>} />
        )}
      </header>
      <nav aria-label={t("inbox.breadcrumb")} className="flex min-w-0 items-center gap-1 border-b border-hairline/40 px-3.5 pb-2 text-[12px] text-ink-tertiary">
        <button type="button" data-inbox-action="open" onClick={() => openInChat(row)} title={t("inbox.action.openInChat")}
          className="min-w-0 max-w-[45%] shrink truncate rounded hover:text-ink hover:underline">{place}</button>
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 rtl:rotate-180" />
        <span className="min-w-0 truncate font-medium text-ink-secondary">{headline}</span>
      </nav>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-3">
        <section aria-label={senderLabel(row)} className="flex gap-2.5">
          <span className="mt-0.5 shrink-0" aria-hidden="true"><InboxSender from={row.from} size={22} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{senderLabel(row)}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">{threadUpdatedLabel(row.at, now)}</span>
            </div>
            {row.via && <div className="truncate text-[12px] text-ink-tertiary">{t("inbox.via", { name: row.via.name })}</div>}
            <div data-inbox-words className="mt-1 space-y-2 text-[14px] leading-6 text-ink">
              {said.map((message) => <ChatMarkdown key={message.id} text={message.text!} />)}
              {words && <ChatMarkdown text={words} />}
            </div>
          </div>
        </section>
        {row.answers?.map((given) => (
          <p key={given.at} className="rounded-xl bg-ink/[0.045] px-3 py-2 text-[13px] text-ink-secondary">
            <span className="block text-[11px] font-medium text-ink-tertiary">{t(given.by === "assistant" ? "inbox.assistantAnswered" : "inbox.youReplied")}</span>
            <span className="whitespace-pre-wrap break-words">{given.text}</span>
          </p>
        ))}
        <section data-inbox-you aria-label={t("inbox.you")} className="flex gap-2.5">
          <span aria-hidden="true" className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-ink-secondary"><UserRound size={13} /></span>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-[13px] font-semibold text-ink">{t("inbox.you")}</div>
            {row.tab === "done" && <p className="flex items-center gap-1.5 text-[13px] text-ink-secondary"><Check size={14} aria-hidden="true" />{settledLabel(row)}</p>}
            <InboxAnswer kind={kind} view={view} row={row} asker={asker} />
          </div>
        </section>
      </div>
    </article>
  );
}
