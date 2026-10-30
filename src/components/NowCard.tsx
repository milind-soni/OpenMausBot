import { useMemo } from "react";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot, type Message } from "@/state/store";
import type { TurnLive } from "@/state/turn-status";
import { cn } from "@/lib/cn";
import { focusActivityRun } from "@/lib/activity-focus";
import { friendlyNowPhrases } from "@/lib/friendly-activity";
import { t } from "@/lib/i18n";
import { turnNowPhrases } from "@/lib/live-activity";
import { nowSteps, type NowStep, type NowStepState } from "@/lib/now-steps";

const MARK: Record<NowStepState, string> = { done: "✓", failed: "✕", now: "●" };
const STATE: Record<NowStepState, LocaleKey> = { done: "chat.now.stateDone", failed: "chat.now.stateFailed", now: "chat.now.stateNow" };

export function NowCard({ steps, tail, onOpenActivity }: { steps: readonly NowStep[]; tail?: readonly string[]; onOpenActivity?: () => void }) {
  return (
    <div className="flex flex-col gap-2" data-now-card="">
      {steps.length > 0 && (
        <ol className="flex flex-col gap-1">
          {steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-baseline gap-2 text-[13px] leading-5" data-now-step={step.state}>
              <span aria-hidden="true" className="w-3 shrink-0 text-center text-[11px] text-ink-tertiary">{MARK[step.state]}</span>
              <span dir="auto" title={step.hover} className={cn("min-w-0 truncate", step.state === "now" ? "text-ink" : "text-ink-secondary")}>{step.label}</span>
              <span className="sr-only">{t(STATE[step.state])}</span>
            </li>
          ))}
        </ol>
      )}
      {tail && tail.length > 0 && (
        <div>
          <span className="sr-only">{t("chat.now.output")}</span>
          <pre dir="ltr" data-now-output="" className="whitespace-pre-wrap break-words rounded-lg bg-ink/[0.04] px-2 py-1.5 font-mono text-[12px] leading-[18px] text-ink-secondary">{tail.join("\n")}</pre>
        </div>
      )}
      {onOpenActivity && (
        <button type="button" onClick={onOpenActivity} className="self-start rounded text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
          {t("chat.now.openActivity")}
        </button>
      )}
    </div>
  );
}

/** Everything the working line of a bot's chat shows: what is happening now, in each mode's words, how a long step is
 * doing, and the card it unfolds. */
export function useTurnNow(bot: Pick<Bot, "id" | "name" | "threadId">, messages: readonly Message[], lastMessage: Message | undefined, live: TurnLive, advanced: boolean) {
  const { dispatch } = useStore();
  const status = live.status;
  const exact = turnNowPhrases(status, lastMessage);
  const shown = advanced ? exact : friendlyNowPhrases(status, lastMessage);
  const steps = useMemo(() => nowSteps(messages, status), [messages, status]);
  const quiet = status && "quiet" in status ? status.quiet : undefined;
  const tail = status?.activity === "command" && "tail" in status ? status.tail : undefined;
  const turnId = live.turnId ?? lastMessage?.turnId;
  const remote = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const openActivity = remote ? undefined : () => {
    focusActivityRun({ botId: bot.id, threadId: bot.threadId, ...(turnId ? { turnId } : {}) });
    dispatch({ type: "toggleActivity", open: true });
  };
  return {
    phrases: shown?.phrases,
    phase: shown?.phase,
    size: shown?.size,
    detail: advanced ? undefined : exact?.phrases[0],
    hover: exact?.hover,
    quiet,
    cardLabel: t("chat.now.title", { name: bot.name }),
    card: steps.length > 0 || tail?.length ? <NowCard steps={steps} tail={tail} onOpenActivity={openActivity} /> : undefined,
  };
}
