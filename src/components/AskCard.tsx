import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Check, Clock3, LoaderCircle, Square, X } from "lucide-react";
import { botButton, type BotButton } from "@/lib/bot-button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausColor } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ELEVATED_CARD } from "./elevated";

/** The bot a card asks for: its face and name lead the card. */
export type Asker = Pick<Bot, "name" | "color"> & Partial<Pick<Bot, "avatarUrl" | "avatarCrop" | "avatarZoom" | "avatarFocusX" | "avatarFocusY" | "mascotBody" | "mascotFaceColor">>;

export function AskHeader({ asker, line, origin }: { asker: Asker; line: string; origin?: { label: string; hint: string; open(): void } }) {
  return (
    <div data-ask-header="" className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-ink-secondary">
      <span aria-hidden="true" className="flex shrink-0"><BotAvatar bot={asker} state="happy" size={16} animated={false} motion="none" motionKey={0} label="" /></span>
      <span dir="auto" className="min-w-0 truncate">{line}</span>
      {origin && (
        <button type="button" onClick={origin.open} aria-label={origin.hint} title={origin.hint}
          className="-ms-1 min-w-0 shrink truncate rounded-md px-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          · {origin.label}
        </button>
      )}
    </div>
  );
}

export function AskCard({
  header,
  icon,
  title,
  meta,
  explanation,
  onDismiss,
  dismissLabel,
  ariaLabel,
  tour,
  children,
  footer,
  onKeyDown,
}: {
  /** An AskHeader: who asks, above the question. */
  header?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  explanation?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  ariaLabel: string;
  tour?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-tour={tour}
      data-ask-card="pending"
      onKeyDown={onKeyDown}
      className={cn("w-full max-w-[560px] rounded-[20px] px-4 pb-3.5 pt-3 text-start", ELEVATED_CARD)}
    >
      {header && <div className="mb-1.5 pe-6">{header}</div>}
      <div className="flex min-w-0 items-start gap-2">
        {icon && <span aria-hidden="true" className="mt-[3px] flex shrink-0 text-ink-secondary">{icon}</span>}
        <div className="min-w-0 flex-1 break-words text-[15px] font-medium leading-[22px] text-ink">
          <bdi dir="auto">{title}</bdi>
        </div>
        {meta && <span className="mt-0.5 shrink-0 text-[12px] tabular-nums text-ink-tertiary">{meta}</span>}
        {onDismiss && dismissLabel && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            title={dismissLabel}
            className={cn(
              "-me-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:size-9",
              header ? "-mt-7" : "-mt-0.5",
            )}
          >
            <X size={15} />
          </button>
        )}
      </div>
      {explanation && <div className="mt-1 text-[14px] leading-5 text-ink-secondary">{explanation}</div>}
      {children && <div className="mt-3">{children}</div>}
      {footer && <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
    </div>
  );
}

/** A command, a link or a quoted message beside the question: a quiet block that folds after three lines. */
export function AskDetail({ text, mono = false, label }: { text: string; mono?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 180 || text.split("\n").length > 3;
  return (
    <div className="mt-2">
      <div
        dir="auto"
        aria-label={label}
        className={cn("rounded-xl bg-ink/[0.045] px-3 py-2 text-ink-secondary [overflow-wrap:anywhere]",
          mono ? "font-mono text-[12px] leading-[18px] whitespace-pre-wrap" : "whitespace-pre-wrap text-[13px] leading-5",
          long && !open && "line-clamp-3")}
      >
        {text}
      </div>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={cn(ASK_QUIET_BUTTON, "mt-1 -ms-2")}>
          {open ? t("question.showLess") : t("ask.detail.more")}
        </button>
      )}
    </div>
  );
}

export type AskChoice = { label: string; description?: string };

/** The answers a question offers, one button each, stacked so a long label wraps instead of being cut. */
export function AskChoices({ choices, label, onPick, sending = null, picked = [], multi = false, disabled = false, quiet = false, tag }: {
  choices: readonly AskChoice[];
  /** The question, for screen readers. */
  label: string;
  onPick(label: string): void;
  /** The choice on its way: it shows that it is being sent, and the others wait. */
  sending?: string | null;
  picked?: readonly string[];
  multi?: boolean;
  disabled?: boolean;
  /** The person has written past this card: its choices recede but still answer. */
  quiet?: boolean;
  /** A data attribute each choice carries with its label, for the surface that shows it. */
  tag?: `data-${string}`;
}) {
  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={label} onKeyDown={moveChoiceFocus} className="flex flex-col gap-1.5">
      {choices.map((choice) => {
        const on = picked.includes(choice.label) || sending === choice.label;
        return (
          <button
            key={choice.label}
            type="button"
            data-ask-choice=""
            {...(tag ? { [tag]: choice.label } : {})}
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            aria-busy={sending === choice.label || undefined}
            disabled={disabled || (sending !== null && sending !== choice.label)}
            onClick={() => onPick(choice.label)}
            className={cn(ASK_CHOICE, on ? "bg-ink/[0.08] ring-ink/25" : "enabled:hover:bg-ink/[0.045]", quiet && !on && "text-ink-secondary")}
          >
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block break-words [unicode-bidi:plaintext]">{choice.label}</span>
              {choice.description && <span dir="auto" className="mt-0.5 block break-words text-[13px] leading-[18px] text-ink-secondary [unicode-bidi:plaintext]">{choice.description}</span>}
            </span>
            {sending === choice.label
              ? <LoaderCircle size={16} aria-hidden="true" className="shrink-0 text-ink-secondary motion-safe:animate-spin" />
              : on && <Check size={16} strokeWidth={2.4} aria-hidden="true" className="shrink-0 text-ink" />}
          </button>
        );
      })}
    </div>
  );
}

/** The person's own words: a field and a send button in the asking bot's colour. */
export function AskReply({ label, placeholder, color, onSend, sending = false, value, onChange, maxLength, multiline = false }: {
  label: string;
  placeholder: string;
  color: MausColor | undefined;
  onSend(text: string): void;
  sending?: boolean;
  value: string;
  onChange(text: string): void;
  maxLength?: number;
  multiline?: boolean;
}) {
  const ready = value.trim().length > 0 && !sending;
  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (ready) onSend(value.trim());
  };
  const button = askPrimary(color, ASK_ICON_SHAPE);
  return (
    <form onSubmit={send} className="flex items-end gap-2 rounded-[16px] bg-ink/[0.045] py-1 pe-1 ps-3 ring-[0.5px] ring-ink/[0.14] focus-within:ring-ink/30">
      <textarea
        dir="auto"
        rows={1}
        value={value}
        maxLength={maxLength}
        aria-label={label}
        placeholder={placeholder}
        disabled={sending}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
        className={cn("block min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-tertiary [field-sizing:content] pointer-coarse:min-h-9",
          multiline ? "max-h-40" : "max-h-28")}
      />
      <button type="submit" disabled={!ready} aria-label={t("chat.send")} title={t("chat.send")} aria-busy={sending || undefined} {...button}>
        {sending ? <LoaderCircle size={16} aria-hidden="true" className="motion-safe:animate-spin" /> : <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />}
      </button>
    </form>
  );
}

/** Why an answer did not go, under the card, until the next try. */
export function AskError({ children }: { children: ReactNode }) {
  return <p role="alert" className="mt-2 text-[13px] leading-[18px] text-danger">{children}</p>;
}

export type AskSettledTone = "done" | "closed" | "stopped" | "expired";

const SETTLED_ICON: Record<AskSettledTone, ReactNode> = {
  done: <Check size={13} strokeWidth={2.4} className="text-success" />,
  closed: <X size={13} />,
  stopped: <Square size={11} strokeWidth={2.4} />,
  expired: <Clock3 size={13} />,
};

export function AskSettledLine({
  icon,
  tone = "done",
  children,
  action,
  detail,
  ariaLabel,
}: {
  icon?: ReactNode;
  tone?: AskSettledTone;
  children: ReactNode;
  action?: ReactNode;
  detail?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-ask-card="settled"
      data-tone={tone}
      className="w-full max-w-[560px] text-start text-[13px] leading-[18px] text-ink-tertiary"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          {icon ?? SETTLED_ICON[tone]}
        </span>
        <span dir="auto" aria-live="polite" className="min-w-0 truncate">{children}</span>
        {action}
      </div>
      {detail}
    </div>
  );
}

/** "You chose: …" when the answer is one of the choices, "You answered: …" for the person's own words. */
export function settledAnswer(answer: string, choices: readonly string[]): ReactNode {
  const label = t(choices.includes(answer) ? "ask.settled.chose" : "ask.settled.answered");
  return <><span>{label}</span> <span className="text-ink-secondary">{answer}</span></>;
}

/**
 * A fixed height with a centered line box keeps Arabic and Latin labels on one baseline band; vertical padding lets
 * each script's font metrics push text off center.
 */
const ASK_SHAPE =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium leading-5 transition-colors [&>svg]:shrink-0 disabled:cursor-not-allowed pointer-coarse:h-9";
/** A card's answers: at least 36px tall, 44 on a touch screen, and a label that wraps rather than being cut. */
export const ASK_BUTTON_SHAPE =
  "inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-center text-[14px] font-medium leading-5 transition-colors [&>svg]:shrink-0 disabled:cursor-not-allowed pointer-coarse:min-h-11";
const ASK_ICON_SHAPE = "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed pointer-coarse:size-9";
const ASK_LOOK = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40";
const ASK_CONTROL = `${ASK_SHAPE} ${ASK_LOOK}`;
const ASK_PRIMARY_LOOK = `${ASK_LOOK} ui-button-primary bg-accent text-accent-ink hover:brightness-110`;

export const ASK_PRIMARY_BUTTON = `${ASK_SHAPE} ${ASK_PRIMARY_LOOK}`;

/** The answer a card waits for, in the asking bot's own button; the plain primary when no single bot asked. */
export function askPrimary(color: MausColor | undefined, shape = ASK_BUTTON_SHAPE): BotButton {
  return botButton(color, shape, ASK_PRIMARY_LOOK);
}

/** A card's other answers: Deny, Cancel, Not now. */
export const ASK_SECONDARY_BUTTON = `${ASK_BUTTON_SHAPE} ${ASK_LOOK} bg-ink/[0.07] text-ink enabled:hover:bg-ink/[0.11] enabled:active:bg-ink/[0.15]`;
/** An extra option that should not compete with the answer: Always allow, Details. */
export const ASK_QUIET_ANSWER = `${ASK_BUTTON_SHAPE} ${ASK_LOOK} text-ink-secondary enabled:hover:bg-ink/[0.06] enabled:hover:text-ink enabled:active:bg-ink/[0.1]`;

const ASK_CHOICE = `flex min-h-10 w-full items-center gap-2.5 rounded-[14px] px-3.5 py-2 text-start text-[14px] leading-5 text-ink ring-[0.5px] ring-ink/[0.14] transition-colors ${ASK_LOOK} disabled:cursor-default pointer-coarse:min-h-11`;

export const ASK_CHIP = `${ASK_CONTROL} max-w-full border`;
export const ASK_CHIP_IDLE = "border-transparent bg-ink/[0.07] text-ink hover:bg-ink/[0.12]";
export const ASK_CHIP_PICKED = "border-accent bg-accent/15 text-ink";

export const ASK_SMALL_PILL = ASK_CONTROL;
export const ASK_QUIET_BUTTON = `${ASK_SMALL_PILL} -my-1 text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink-secondary`;

export const ASK_FIELD =
  "h-7 rounded-full border border-hairline/60 bg-inset px-3 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60 pointer-coarse:h-9";

export function returnFocusToComposer(): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
}

export function moveChoiceFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget;
  const items = Array.from(group.querySelectorAll<HTMLElement>("[data-ask-choice]:not([disabled])"));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const rtl = getComputedStyle(group).direction === "rtl";
  const forward = event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight");
  const backward = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (forward) next = current < 0 ? 0 : (current + 1) % items.length;
  else if (backward) next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}
