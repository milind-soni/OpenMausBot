// Run for a saved burger that has inputs: one compact form with each input, filled with the value it was saved with, so
// the person sees what the run will use and changes what differs this time. A burger without inputs runs at once.
import { CirclePlay } from "lucide-react";
import { useState, type FormEvent } from "react";

import type { Workflow } from "../../../shared/skill-burger/format";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readBurgerWorkflow, type SavedWorkflow } from "@/lib/skill-burger";

const FIELD = "w-full min-w-0 rounded-md border border-hairline/60 bg-card px-2 py-1 text-[13px] text-ink outline-none focus:border-accent";

export function RunWithInputs({ skill, onRun, className, iconOnly, panelAction }: {
  skill: SavedWorkflow;
  onRun: (inputs: Record<string, string>) => void;
  className: string;
  iconOnly?: boolean;
  /** The bot panel's name for this action, on the button itself. */
  panelAction?: string;
}) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const open = async () => {
    if (!skill.args.length) { onRun({}); return; }
    if (values) { setValues(null); return; }
    let saved: Workflow["args"] = {};
    try { saved = ((await readBurgerWorkflow(skill)) as Workflow | null)?.args ?? {}; } catch { /* run with empty fields */ }
    setValues(Object.fromEntries(skill.args.map((name) => [name, typeof saved[name]?.default === "string" ? saved[name]!.default as string : saved[name]?.default === undefined ? "" : JSON.stringify(saved[name]!.default)])));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!values) return;
    onRun(values);
    setValues(null);
  };
  return (
    <>
      <button type="button" onClick={() => void open()} aria-expanded={skill.args.length ? Boolean(values) : undefined}
        aria-label={t("skillBurger.runName", { name: skill.summary })} title={t("skillBurger.run.button")} data-run-burger={skill.name} {...(panelAction ? { "data-panel-action": panelAction } : {})} className={className}>
        <CirclePlay size={14} aria-hidden="true" />{iconOnly ? null : t("skillBurger.run.button")}
      </button>
      {values && (
        <form onSubmit={submit} className="flex w-full basis-full flex-col gap-1.5 rounded-lg bg-ink/[0.03] p-2" data-burger-run-inputs>
          <span className="text-[12px] text-ink-secondary">{t("skillBurger.run.inputs")}</span>
          {skill.args.map((name, index) => (
            <label key={name} className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-[11px] text-ink-tertiary">{name}</span>
              <input dir="auto" autoFocus={index === 0} value={values[name] ?? ""} maxLength={2_000} className={FIELD}
                onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
            </label>
          ))}
          <button type="submit" className={cn("ui-button ui-button-md self-end")}>{t("skillBurger.run.go")}</button>
        </form>
      )}
    </>
  );
}
