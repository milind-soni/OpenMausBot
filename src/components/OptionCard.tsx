import { useState } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isPersistentQuestionCard, parseChoices } from "../../shared/ask-question";
import { ASK_FIELD, ASK_QUIET_BUTTON, AskCard, AskSettledLine, moveChoiceFocus, returnFocusToComposer } from "./AskCard";
import { ExpandableText } from "./ExpandableText";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** First-run quiz, not a live provider ask (those carry requestId). */
export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && !message.card.requestId;
}

/** Hide the quiz once they have talked past it — picked an option, typed in
 * the composer, or dismissed it. Live asks are never this card. */
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

export function OptionCard({
  botId,
  threadId,
  message,
  /** set when the card is in a room: the answer belongs to the room's thread */
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
  // Full thread, not the mounted window: a search-focus slice can omit the
  // later user message that means they already talked past this quiz.
  if (!card || shouldHideOnboardingCard(message, transcript) || (card.requestId && card.dismissed && card.answered)) return null;

  const title = card.title;
  const subtitle = card.subtitle;
  // Cards saved before the server flattened `ask_user` choices can still hold
  // `{ label }` rows; a label is drawable, an object as a React child is not.
  const options = parseChoices(card.options, LETTERS.length) ?? [];

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: text.trim(), groupId });
    if (card.requestId) returnFocusToComposer();
  };

  const dismiss = canDismissOptionCard(card)
    ? () => dispatch({ type: "dismissCard", botId, threadId, messageId: message.id, groupId })
    : undefined;

  // A live ask that has been answered folds into one line: what was asked,
  // then what was picked. The first-run quiz never gets here, it hides.
  if (card.requestId && card.answered) {
    // `answered` is the verdict for a permission-shaped ask and the picked
    // label for a flat one; a deny or a run that ended is no answer at all.
    const closed = !card.answeredText && (card.answered === "deny" || card.answered === "unavailable");
    const picked = closed
      ? undefined
      : card.answeredText ?? (card.answered === "answer" || card.answered === "allow" ? "" : card.answered);
    return (
      <AskSettledLine
        ariaLabel={title}
        icon={picked === undefined ? <X size={13} /> : undefined}
        action={dismiss && (
          <button type="button" onClick={dismiss} aria-label={t("onboarding.card.dismiss")} title={t("onboarding.card.dismiss")} className={cn(ASK_QUIET_BUTTON, "w-7 px-0")}>
            <X size={14} />
          </button>
        )}
      >
        <span>{title}</span>
        <span className="text-ink-secondary"> · {closed ? t("question.status.closed") : picked || t("question.status.answered")}</span>
      </AskSettledLine>
    );
  }

  return (
    <AskCard
      ariaLabel={title}
      icon={<MessageCircleQuestion size={15} />}
      title={title}
      explanation={subtitle ? <ExpandableText text={subtitle} className="text-[13px] text-ink-secondary" /> : undefined}
      onDismiss={dismiss}
      dismissLabel={t("onboarding.card.dismiss")}
    >
      {options.length > 0 && (
        <div onKeyDown={moveChoiceFocus} className="overflow-hidden rounded-2xl border border-hairline/40">
          {options.map((opt, i) => (
            <button
              key={opt}
              type="button"
              data-ask-choice=""
              disabled={!!card.answered}
              onClick={() => answer(opt)}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-start text-[13px] font-medium leading-5 text-ink",
                i > 0 && "border-t border-hairline/40",
                // `raised` is the wrong fill here: the light skins define it as
                // pure white, the same value as the card underneath, so a
                // hovered or answered row used to be invisible. `raised-hover`
                // is the one tone every skin guarantees stands off a surface.
                (card.answeredText ?? card.answered) === opt
                  ? "bg-raised-hover"
                  : "hover:bg-raised-hover/60 disabled:hover:bg-transparent",
              )}
            >
              {/* `control` is the chip tone every skin guarantees on a card; the
                  hairline keeps it a chip even on a row that is itself filled */}
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-hairline/50 bg-control text-[11px] font-medium text-ink-secondary">
                {LETTERS[i]}
              </span>
              <span dir="auto" className="min-w-0 break-words">{opt}</span>
            </button>
          ))}
        </div>
      )}

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          dir="auto"
          value={custom}
          aria-label={t("onboarding.card.custom")}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && answer(custom)}
          placeholder={t("onboarding.card.custom")}
          className={cn(
            ASK_FIELD,
            "block w-full",
            options.length > 0 && "mt-2",
          )}
        />
      )}
    </AskCard>
  );
}
