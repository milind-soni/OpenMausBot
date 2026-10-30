import { useState } from "react";
import { X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isPersistentQuestionCard, parseChoices } from "../../shared/ask-question";
import { ASK_QUIET_BUTTON, AskCard, AskChoices, AskReply, AskSettledLine, returnFocusToComposer, settledAnswer } from "./AskCard";
import { ExpandableText } from "./ExpandableText";

const MAX_CHOICES = 6;

export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && !message.card.requestId;
}

export function shouldHideOnboardingCard(message: Message, transcript: Message[]): boolean {
  if (!isOnboardingCard(message) || !message.card) return false;
  if (message.card.dismissed || message.card.answered) return true;
  const index = transcript.findIndex((entry) => entry.id === message.id);
  if (index < 0) return false;
  return transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

export function canDismissOptionCard(card: NonNullable<Message["card"]>): boolean {
  if (card.requestId && isPersistentQuestionCard(card)) return card.answered === "answer" && !card.dismissed;
  return true;
}

/** A card of choices that is not a bot's own question: a first-run quiz, an offer to switch engines, a watcher's note. */
export function OptionCard({
  botId,
  threadId,
  message,
  groupId,
}: {
  botId: string;
  threadId?: string;
  message: Message;
  groupId?: string;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  // Full thread, not the mounted window: a search-focus slice can omit the later message that hides this quiz.
  if (!card || shouldHideOnboardingCard(message, transcript) || (card.requestId && card.dismissed && card.answered)) return null;

  const options = parseChoices(card.options, MAX_CHOICES) ?? [];
  const index = transcript.findIndex((entry) => entry.id === message.id);
  const quiet = !card.answered && index >= 0 && transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: text.trim(), groupId });
    if (card.requestId) returnFocusToComposer();
  };

  const dismiss = canDismissOptionCard(card)
    ? () => dispatch({ type: "dismissCard", botId, threadId, messageId: message.id, groupId })
    : undefined;

  if (card.requestId && card.answered) {
    const closed = !card.answeredText && (card.answered === "deny" || card.answered === "unavailable");
    const picked = closed ? undefined : card.answeredText ?? (card.answered === "answer" || card.answered === "allow" ? "" : card.answered);
    return (
      <AskSettledLine
        ariaLabel={card.title}
        tone={picked === undefined ? "closed" : "done"}
        action={dismiss && (
          <button type="button" onClick={dismiss} aria-label={t("onboarding.card.dismiss")} title={t("onboarding.card.dismiss")} className={cn(ASK_QUIET_BUTTON, "w-7 px-0")}>
            <X size={14} />
          </button>
        )}
      >
        {closed ? t("question.status.closed") : picked ? settledAnswer(picked, options) : <span>{card.title} · {t("question.status.answered")}</span>}
      </AskSettledLine>
    );
  }

  return (
    <AskCard
      ariaLabel={card.title}
      title={card.title}
      explanation={card.subtitle ? <ExpandableText text={card.subtitle} className="text-[14px] leading-5 text-ink-secondary" /> : undefined}
      onDismiss={dismiss}
      dismissLabel={t("onboarding.card.dismiss")}
    >
      {options.length > 0 && (
        <AskChoices
          choices={options.map((label) => ({ label }))}
          label={card.title}
          picked={card.answeredText ?? card.answered ? [card.answeredText ?? card.answered!] : []}
          disabled={Boolean(card.answered)}
          quiet={quiet}
          onPick={answer}
        />
      )}
      {!card.answered && !card.tool && !card.fixedOptions && (
        <div className={options.length > 0 ? "mt-2" : undefined}>
          <AskReply
            label={t("onboarding.card.custom")}
            placeholder={t(options.length ? "question.somethingElse" : "onboarding.card.custom")}
            color={bot?.color}
            value={custom}
            onChange={setCustom}
            onSend={answer}
          />
        </div>
      )}
    </AskCard>
  );
}
