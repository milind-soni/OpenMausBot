import { useState, type ReactNode } from "react";
import { Check, ExternalLink } from "lucide-react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { replyToInboxRow, settleInboxRow } from "@/state/inbox";
import { ASK_QUIET_ANSWER, AskReply } from "../AskCard";
import { ELEVATED_CARD } from "../elevated";
import { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } from "../PendingApproval";
import { ConnectorCard } from "../ConnectorCard";
import { QuestionCard } from "../QuestionCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { SignInRequestCard } from "../SignInRequestCard";
import { asMessage, singleQuestion, type InboxAnswerKind } from "./inbox-answer";
import { InboxQuestionAnswer } from "./InboxQuestionAnswer";
import { answerThread } from "./inbox-view";
import { useInboxActions } from "./use-inbox-actions";

interface AnswerProps { view: InboxView; row: InboxRow; threadId: string | null; asker?: Bot }

function QuestionAnswer({ view, row, threadId, asker }: AnswerProps) {
  const { answer } = useInboxActions(view);
  const question = singleQuestion(row);
  if (!threadId) return null;
  if (!question) return <QuestionCard threadId={threadId} asker={asker} message={asMessage(row)} />;
  return <InboxQuestionAnswer row={row} question={question} asker={asker}
    onAnswer={(response, failed) => { answer(row, response, failed); settleInboxRow(row); }} />;
}

function ApprovalAnswer({ row, threadId, asker }: AnswerProps) {
  const approval = threadId ? pendingApprovals([asMessage(row)])[0] : undefined;
  if (!approval || !threadId) return null;
  return (
    <div className={cn("rounded-[18px]", ELEVATED_CARD)}>
      <PendingApprovalPanel pending={approval} count={1} index={0} botName={asker?.name ?? row.from.name} asker={asker}
        actions={<PendingApprovalActions part="primary" tag="inbox" pending={approval} threadId={threadId} bot={asker} onCancelTurn={() => {}} />} />
    </div>
  );
}

function ReviewAnswer({ view, row }: AnswerProps) {
  const { openInChat } = useInboxActions(view);
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-ink-secondary">{t("inbox.reviewInChat")}</p>
      <button type="button" onClick={() => openInChat(row)} className={ASK_QUIET_ANSWER}><ExternalLink size={15} aria-hidden="true" />{t("inbox.action.openInChat")}</button>
    </div>
  );
}

function PasswordAnswer({ row, threadId, asker }: AnswerProps) {
  const botId = row.from.botId;
  return botId && threadId ? <SecretRequestCard botId={botId} color={asker?.color} threadId={threadId} message={asMessage(row)} /> : null;
}

function ConnectAnswer({ row, threadId, asker }: AnswerProps) {
  const botId = row.from.botId;
  return botId && threadId ? <ConnectorCard botId={botId} color={asker?.color} threadId={threadId} message={asMessage(row)} /> : null;
}

function SignInAnswer({ row, threadId, asker }: AnswerProps) {
  const botId = row.from.botId;
  return botId && threadId ? <SignInRequestCard botId={botId} botName={asker?.name ?? row.from.name} color={asker?.color} threadId={threadId} message={asMessage(row)} /> : null;
}

function DoneButton({ view, row }: AnswerProps) {
  const { run } = useInboxActions(view);
  if (row.tab !== "info") return null;
  return <button type="button" data-inbox-action="done" onClick={() => run(row, "done")} className={ASK_QUIET_ANSWER}><Check size={15} aria-hidden="true" />{t("common.done")}</button>;
}

function ReplyAnswer(props: AnswerProps) {
  const { view, row, asker } = props;
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (text: string) => {
    if (sending) return;
    setSending(true);
    try {
      await replyToInboxRow(view, row, text);
      setReply("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="space-y-2">
      <AskReply label={t("inbox.reply.placeholder")} placeholder={t("inbox.reply.placeholder")} color={asker?.color} value={reply} onChange={setReply}
        onSend={(text) => void send(text)} sending={sending} multiline />
      <DoneButton {...props} />
    </div>
  );
}

const ANSWERS: Record<InboxAnswerKind, (props: AnswerProps) => ReactNode> = {
  question: QuestionAnswer,
  approval: ApprovalAnswer,
  review: ReviewAnswer,
  password: PasswordAnswer,
  "sign-in": SignInAnswer,
  connect: ConnectAnswer,
  reply: ReplyAnswer,
  none: DoneButton,
};

export function InboxAnswer({ kind, view, row, asker }: { kind: InboxAnswerKind; view: InboxView; row: InboxRow; asker?: Bot }) {
  const Answer = ANSWERS[kind];
  return <div data-inbox-answer-kind={kind}><Answer view={view} row={row} threadId={answerThread(view, row)} asker={asker} /></div>;
}
