import type { ReactNode } from "react";
import type { Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";
import { HelperIntro } from "./HelperIntro";
import { MessageBoundary } from "./MessageBoundary";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { QuestionCard } from "./QuestionCard";

/**
 * Called, not mounted: a quiz that dropped out must come back as null so the transcript draws no row and no day
 * separator.
 */
export function optionsCardRow({ message: m, transcript, botId, botName, threadId }: {
  message: Message;
  transcript: Message[];
  botId: string;
  botName: string;
  threadId: string;
}): ReactNode {
  const card = m.helperIntro ? (
    <HelperIntro botId={botId} threadId={threadId} message={m} asksDone={shouldHideOnboardingCard(m, transcript)} />
  ) : m.card?.requestId && m.card.questionRequest ? (
    <QuestionCard threadId={threadId} bot={{ name: botName }} message={m} />
  ) : m.card?.requestId && m.card.tool ? (
    <ApprovalCard bot={{ name: botName }} message={m} threadId={threadId} />
  ) : shouldHideOnboardingCard(m, transcript) ? null : (
    <OptionCard botId={botId} threadId={threadId} message={m} />
  );
  if (!card) return null;
  return (
    <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
      {card}
    </MessageBoundary>
  );
}
