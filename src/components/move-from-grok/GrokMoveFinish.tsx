import { Check, ChevronRight, Circle } from "lucide-react";

import { Footer, PRIMARY, SECONDARY, StepHeading } from "@/components/cloud-welcome/parts";
import { cn } from "@/lib/cn";
import type { GrokMoved, GrokMoveRow } from "@/lib/grok-move";
import { t } from "@/lib/i18n";

/** Third screen: what still needs the person, one tap each. Says so when nothing does. */
export function GrokMoveFinish({ moved, rows, onOpen, onAnother, onDone }: {
  moved: readonly GrokMoved[];
  rows: readonly GrokMoveRow[];
  onOpen: (row: GrokMoveRow) => void;
  onAnother: () => void;
  onDone: () => void;
}) {
  const names = moved.map((item) => item.bot.name).join(", ");
  const left = rows.filter((row) => !row.done).length;
  const skipped = moved.flatMap((item) => (item.serversSkipped > 0 ? [item.bot.name] : []));
  return (
    <section aria-labelledby="grok-move-title" data-grok-move-step="finish" data-grok-move-left={left} className="flex flex-col gap-4">
      <StepHeading id="grok-move-title" title={t("grokMove.finish.title", { names })}
        sub={left ? t("grokMove.finish.sub") : t("grokMove.finish.allDone")} />
      {rows.length > 0 && (
        <ul className="flex flex-col overflow-hidden rounded-2xl bg-card">
          {rows.map((row) => (
            <li key={row.key} data-grok-move-row={row.id} data-done={row.done || undefined} className="border-b border-hairline/30 last:border-b-0">
              <button type="button" onClick={() => onOpen(row)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-offset-[-2px]">
                {row.done
                  ? <Check size={16} strokeWidth={2.5} aria-label={t("grokMove.finish.done")} className="shrink-0 text-success" />
                  : <Circle size={16} aria-hidden="true" className="shrink-0 text-ink-tertiary" />}
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[14px] font-medium", row.done ? "text-ink-secondary" : "text-ink")}>{row.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-secondary">{row.detail}</span>
                </span>
                <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
              </button>
              {row.rebuild && row.rebuild.length > 0 && (
                <details className="px-4 pb-3 pl-[44px] text-[13px] text-ink-secondary">
                  <summary className="cursor-pointer text-accent-text">{t("grokMove.finish.seeRebuild")}</summary>
                  <ul className="mt-2 flex flex-col gap-3">
                    {row.rebuild.map((routine) => (
                      <li key={routine.name}>
                        <div className="font-medium text-ink">{routine.name}{routine.trigger && <span className="font-normal text-ink-secondary"> · {routine.trigger}</span>}</div>
                        {(routine.details || routine.when) && <div>{routine.details || routine.when}</div>}
                        <p className="mt-1 whitespace-pre-wrap break-words">{routine.instruction}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && <p role="note" className="text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.finish.serversSkipped", { names: skipped.join(", ") })}</p>}
      <Footer className="mt-1">
        <button type="button" data-grok-move-done onClick={onDone} className={PRIMARY}>{t("common.done")}</button>
        <button type="button" data-grok-move-another onClick={onAnother} className={SECONDARY}>{t("grokMove.finish.another")}</button>
      </Footer>
    </section>
  );
}
