import { useState } from "react";

import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import type { LocaleKey } from "@/locales";
import { readBurgerWorkflow, removeBurger, restoreBurger, runBurgerIn, useSavedBurgers, type SavedWorkflow } from "@/lib/skill-burger";
import { useStoreDispatch } from "@/state/store-select";
import { Card, NoteRow, TrashButton } from "../bot-panel/rows";
import { MiniBurger } from "./MiniBurger";
import { RunWithInputs } from "./RunInputs";
import { LayerIcon } from "./SkillBurger";

/** Takes a burger away, keeping what it takes to put it back. */
export function useBurgerRemoval() {
  const [removed, setRemoved] = useState<{ skill: SavedWorkflow; workflow: unknown } | null>(null);
  const [problem, setProblem] = useState("");
  const fail = (cause: unknown, fallback: LocaleKey) => setProblem(cause instanceof Error && cause.message ? cause.message : t(fallback));
  const remove = async (skill: SavedWorkflow) => {
    setProblem("");
    try {
      const workflow = await readBurgerWorkflow(skill);
      await removeBurger(skill);
      setRemoved({ skill, workflow });
    } catch (cause) {
      fail(cause, "skillBurger.list.removeFailed");
    }
  };
  const undo = async () => {
    if (!removed) return;
    try {
      await restoreBurger(removed.skill, removed.workflow);
      setRemoved(null);
    } catch (cause) {
      fail(cause, "skillBurger.undoFailed");
    }
  };
  return { removed, problem, remove, undo };
}

/** The bot panel's Skill Burgers: every saved one, which every bot uses. Open one to see its steps; remove one (whoever
 * saved it, or an admin) with an Undo. */
export function SavedWorkflowsCard({ botId, threadId }: { botId: string; threadId: string }) {
  const { skills: all, error } = useSavedBurgers();
  const dispatch = useStoreDispatch();
  const advanced = useAdvancedMode();
  const skills = all;
  const [open, setOpen] = useState<string | null>(null);
  const { removed, problem, remove, undo } = useBurgerRemoval();

  return (
    <Card label={t("skillBurger.list.title")} anchor="skill-burgers">
      {skills === null ? (
        <NoteRow>{error ? t("skillBurger.list.loadFailed") : t("skills.loading")}</NoteRow>
      ) : skills.length === 0 && !removed ? (
        <NoteRow>{t("skillBurger.list.empty")}</NoteRow>
      ) : skills.map((skill) => {
        const key = skill.name;
        const expanded = open === key;
        const listId = `skill-burger-${skill.name}`;
        return (
          <div key={key} data-panel-row={`skill-burger:${skill.name}`}>
            <div className="flex min-h-[46px] flex-wrap items-start gap-3 px-3.5 py-[10px]">
              <MiniBurger skill={skill} size="sm" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setOpen(expanded ? null : key)}
                  className="min-w-0 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <span dir="auto" className="line-clamp-2 text-[14px] font-medium leading-[18px] text-ink">{skill.summary}</span>
                  {advanced && <span className="mt-px block truncate font-mono text-[11px] text-ink-tertiary">{skill.name}</span>}
                </button>
              </div>
              <RunWithInputs skill={skill} iconOnly panelAction={`run-skill-burger:${skill.name}`} onRun={(inputs) => runBurgerIn(dispatch, { id: botId, threadId }, skill.name, inputs)}
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-ink/[0.05] hover:text-ink" />
              {skill.canChange !== false && <TrashButton data-panel-action={`remove-skill-burger:${skill.name}`} label={t("skillBurger.list.remove", { name: skill.name })} onClick={() => void remove(skill)} />}
            </div>
            <ol id={listId} hidden={!expanded} aria-label={t("skillBurger.layers")} className="flex flex-col gap-1 px-3.5 pb-3">
              {skill.layers.map((layer, index) => (
                <li key={index} className="flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary">
                  <LayerIcon kind={layer.kind} app={layer.app} />
                  <span className="min-w-0 flex-1 truncate">{layer.label}</span>
                  {layer.kind === "ai" && <span className="shrink-0 text-[11px] text-ink-tertiary">{t("skillBurger.aiTag")}</span>}
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      {removed && (
        <div role="status" className="flex min-h-[40px] items-center gap-2 px-3.5 text-[13px] text-ink-secondary">
          <span className="min-w-0 flex-1 truncate">{t("skillBurger.list.removed", { name: removed.skill.name })}</span>
          <button type="button" onClick={() => void undo()} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text hover:bg-ink/[0.06]">{t("common.undo")}</button>
        </div>
      )}
      {problem && <NoteRow tone="warn">{problem}</NoteRow>}
    </Card>
  );
}
