// The finished run on the burger card, the way a person would explain it: its inputs (rename one, or give it another
// saved value), each step in plain words with who did it, opened to see what was asked and what came back, what "done"
// meant and how many tries or rounds it took. A step can be left out before saving; a step that uses its output goes
// with it. Nothing here is saved until the person adds the burger.
import { Check, ChevronRight, Users } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { composedFor, dependents, type DraftStepView, type DraftView } from "../../../shared/skill-burger/draft-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { LayerIcon } from "./SkillBurger";

export type InputChoices = Record<string, { name?: string; value?: string }>;

const FIELD = "w-full min-w-0 rounded-md border border-hairline/60 bg-card px-1.5 py-0.5 text-[12px] text-ink outline-none focus:border-accent";
const QUIET = "text-[11px] text-ink-tertiary";

/** "Kiwi, Rio and Miso". */
function names(list: readonly string[]): string {
  return list.length > 1 ? t("skillBurger.draft.names", { some: list.slice(0, -1).join(", "), last: list[list.length - 1]! }) : list[0] ?? "";
}

/** A step's line in the person's language where the words are ours. */
export function draftLine(step: DraftStepView): string {
  if (step.kind === "delegate" && step.who?.length) return t("skillBurger.layer.ask", { who: names(step.who.map((one) => one.name)) });
  if (step.label === "Review what came back and report") return t("skillBurger.layer.review");
  return step.label;
}

export function DraftInputs({ inputs, choices, onChange, disabled }: {
  inputs: DraftView["inputs"];
  choices: InputChoices;
  onChange: (name: string, choice: { name?: string; value?: string }) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!inputs.length) return null;
  return (
    <div className="burger-layer burger-open flex min-w-0 flex-col gap-1 rounded-[8px] bg-card px-3 py-2 text-[12px] shadow-sm" data-burger-inputs>
      <span className={QUIET}>{t("skillBurger.draft.inputs")}</span>
      <ul className="flex flex-wrap gap-1">
        {inputs.map((input) => {
          const chosen = choices[input.name] ?? {};
          const name = chosen.name ?? input.name;
          const value = chosen.value ?? input.value;
          if (open === input.name && !disabled) {
            const keys = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); setOpen(null); } };
            return (
              <li key={input.name} className="flex w-full min-w-0 flex-col gap-1">
                <input dir="ltr" aria-label={t("skillBurger.draft.inputName")} value={name} maxLength={40} className={cn(FIELD, "font-mono")}
                  onChange={(event) => onChange(input.name, { ...chosen, name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} onKeyDown={keys} />
                <input dir="auto" aria-label={t("skillBurger.draft.inputValue")} value={value} maxLength={2_000} className={FIELD}
                  onChange={(event) => onChange(input.name, { ...chosen, value: event.target.value })} onKeyDown={keys} />
                <button type="button" onClick={() => setOpen(null)} className="self-end rounded-md px-1.5 text-[12px] font-medium text-accent-text hover:bg-ink/[0.06]">{t("common.done")}</button>
              </li>
            );
          }
          return (
            <li key={input.name} className="min-w-0 max-w-full">
              <button type="button" disabled={disabled} onClick={() => setOpen(input.name)} title={t("skillBurger.draft.editInput", { name })}
                className="flex max-w-full items-baseline gap-1 rounded-full bg-ink/[0.05] px-2 py-0.5 text-start outline-none enabled:hover:bg-ink/[0.09] focus-visible:ring-2 focus-visible:ring-accent/60">
                <span className="shrink-0 font-mono text-[11px] text-ink-secondary">{name}</span>
                <span className="min-w-0 truncate">{value}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Detail({ step }: { step: DraftStepView }) {
  return (
    <div className="mt-1.5 flex min-w-0 flex-col gap-1.5 ps-[26px] text-[12px] text-ink-secondary" data-burger-detail>
      {step.detail && <code className="block max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] text-ink-secondary">{step.detail}</code>}
      {step.asked?.length ? (
        <div className="flex flex-col gap-1">
          <span className={QUIET}>{t("skillBurger.draft.asked")}</span>
          {step.asked.map((one) => <p key={one.who} className="line-clamp-3 min-w-0"><b className="font-medium text-ink">{one.who}</b>{" · "}{one.text}</p>)}
        </div>
      ) : null}
      {step.back?.length ? (
        <div className="flex flex-col gap-1">
          <span className={QUIET}>{t("skillBurger.draft.cameBack")}</span>
          {step.back.map((one) => (
            <p key={`${one.who}:${one.round}`} className={cn("line-clamp-3 min-w-0", !one.ok && "text-danger")}>
              <b className="font-medium text-ink">{one.who}</b>{step.rounds && step.rounds > 1 ? <span className={QUIET}>{" "}{t("skillBurger.draft.round", { round: one.round })}</span> : null}{" · "}{one.text}
            </p>
          ))}
        </div>
      ) : null}
      {step.doneWhen && <p className="min-w-0">{t("skillBurger.draft.doneWhen", { check: step.doneWhen })}</p>}
      {step.reviewRounds ? <p className="min-w-0">{t("skillBurger.draft.reviewRounds", { count: step.reviewRounds })}</p> : null}
      {!step.exact && <p className="min-w-0">{t("skillBurger.draft.judgement")}</p>}
    </div>
  );
}

/** The run's steps with a keep box each; `skipped` are the ones left out. */
export function DraftSteps({ steps, skipped, onSkip, disabled }: {
  steps: DraftStepView[];
  skipped: ReadonlySet<string>;
  onSkip: (next: ReadonlySet<string>) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const shown = steps.filter((step) => !steps.some((other) => other.id === composedFor(step.id)));
  const toggle = (step: DraftStepView) => {
    const next = new Set(skipped);
    const linked = [step.id, ...dependents(steps, step.id)];
    if (skipped.has(step.id)) { next.delete(step.id); for (const need of step.needs) next.delete(need); } else for (const id of linked) next.add(id);
    onSkip(next);
  };
  return (
    <ol aria-label={t("skillBurger.layers")} className="burger-layers flex max-h-80 min-h-0 flex-col gap-[3px] overflow-y-auto">
      {shown.map((step) => {
        const line = draftLine(step);
        const kept = !skipped.has(step.id);
        const expanded = open.has(step.id);
        const judged = !step.exact || steps.some((other) => composedFor(other.id) === step.id && !other.exact);
        return (
          <li key={step.id} data-burger-layer={step.kind} data-kept={kept ? "true" : "false"}
            className={cn("burger-layer burger-open flex min-w-0 shrink-0 flex-col rounded-[8px] bg-card px-2 py-1.5 text-[13px] shadow-sm", !kept && "opacity-50")}>
            <span className="flex min-h-7 min-w-0 items-center gap-2">
              <label className="flex shrink-0 cursor-pointer items-center" title={t("skillBurger.draft.keep", { step: line })}>
                <input type="checkbox" className="peer sr-only" checked={kept} disabled={disabled} onChange={() => toggle(step)} aria-label={t("skillBurger.draft.keep", { step: line })} />
                <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-[5px] border border-hairline bg-raised text-ink peer-checked:border-accent peer-checked:bg-accent peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60">
                  {kept && <Check size={11} strokeWidth={3} />}
                </span>
              </label>
              <button type="button" onClick={() => setOpen((current) => { const next = new Set(current); if (next.has(step.id)) next.delete(step.id); else next.add(step.id); return next; })}
                aria-expanded={expanded} title={t("skillBurger.draft.details", { step: line })}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                {step.kind === "delegate" ? <Users size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" /> : <LayerIcon kind={step.kind} app={step.app} />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("min-w-0 truncate", judged && "text-ink-secondary", !kept && "line-through")}>{line}</span>
                  {(step.who?.length || step.tries || (step.rounds && step.rounds > 1)) ? (
                    <span className="min-w-0 truncate text-[11px] text-ink-tertiary">
                      {[
                        step.who?.length ? step.who.map((one) => (one.role ? `${one.name} · ${one.role}` : one.name)).join(", ") : "",
                        step.rounds && step.rounds > 1 ? t("skillBurger.draft.rounds", { count: step.rounds }) : "",
                        step.tries ? t("skillBurger.draft.tries", { count: step.tries + 1 }) : "",
                      ].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
                {judged && <span className="ms-auto shrink-0 text-[11px] text-ink-tertiary">{t("skillBurger.aiTag")}</span>}
                <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
              </button>
            </span>
            {expanded && <Detail step={step} />}
          </li>
        );
      })}
    </ol>
  );
}

/** One honest line: how much of it repeats exactly, and how much the bot redoes with judgement. */
export function replayLine(steps: DraftStepView[], skipped: ReadonlySet<string>): string {
  const kept = steps.filter((step) => !skipped.has(step.id) && !steps.some((other) => other.id === composedFor(step.id)));
  const judged = kept.filter((step) => !step.exact || steps.some((other) => composedFor(other.id) === step.id && !other.exact)).length;
  if (!judged) return t("skillBurger.draft.allExact");
  if (judged === kept.length) return t("skillBurger.draft.allJudgement");
  return t("skillBurger.draft.mix", { exact: kept.length - judged, judgement: judged });
}
