import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readBurgerWorkflow, removeBurger, restoreBurger, useSavedBurgers, type SavedWorkflow } from "@/lib/skill-burger";
import { Card, NoteRow, TrashButton } from "../bot-panel/rows";
import { LayerIcon } from "./SkillBurger";

const STACK_ICONS = 4;

/** A saved burger in miniature: its first few layers' icons, overlapping like a stack. */
function MiniBurger({ skill }: { skill: SavedWorkflow }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center">
      {skill.layers.slice(0, STACK_ICONS).map((layer, index) => (
        <span key={index} className={cn("flex size-6 items-center justify-center rounded-full bg-card ring-1 ring-ink/[0.06]", index > 0 && "-ms-1.5")}>
          <LayerIcon kind={layer.kind} app={layer.app} />
        </span>
      ))}
    </span>
  );
}

/** The bot panel's saved burgers: every bot has them. Open one to see its steps; remove it with an Undo. */
export function SavedWorkflowsCard() {
  const { skills, error } = useSavedBurgers();
  const [open, setOpen] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ name: string; workflow: unknown } | null>(null);
  const [problem, setProblem] = useState("");

  const remove = async (skill: SavedWorkflow) => {
    setProblem("");
    try {
      const workflow = await readBurgerWorkflow(skill.name);
      await removeBurger(skill.name, skill.sha256);
      setRemoved({ name: skill.name, workflow });
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : t("skillBurger.list.removeFailed"));
    }
  };
  const undo = async () => {
    if (!removed) return;
    try {
      await restoreBurger(removed.name, removed.workflow);
      setRemoved(null);
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : t("skillBurger.undoFailed"));
    }
  };

  return (
    <Card label={t("skillBurger.list.title")} anchor="saved-workflows">
      {skills === null ? (
        <NoteRow>{error ? t("skillBurger.list.loadFailed") : t("skills.loading")}</NoteRow>
      ) : skills.length === 0 && !removed ? (
        <NoteRow>{t("skillBurger.list.empty")}</NoteRow>
      ) : skills.map((skill) => {
        const expanded = open === skill.name;
        const listId = `saved-burger-${skill.name}`;
        return (
          <div key={skill.name} data-panel-row={`saved-workflow:${skill.name}`}>
            <div className="flex min-h-[46px] items-center gap-2.5 px-3.5 py-[9px]">
              <MiniBurger skill={skill} />
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setOpen(expanded ? null : skill.name)}
                className="min-w-0 flex-1 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <span dir="auto" className="block truncate text-[14px] font-medium text-ink">{skill.summary}</span>
                <span className="mt-px block truncate text-[12px] text-ink-secondary">
                  <span className="font-mono">{skill.name}</span>{" · "}{skill.layers.length === 1 ? t("skillBurger.layersOne") : t("skillBurger.layersMany", { count: skill.layers.length })}
                </span>
              </button>
              <TrashButton data-panel-action={`remove-workflow:${skill.name}`} label={t("skillBurger.list.remove", { name: skill.name })} onClick={() => void remove(skill)} />
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
          <span className="min-w-0 flex-1 truncate">{t("skillBurger.list.removed", { name: removed.name })}</span>
          <button type="button" onClick={() => void undo()} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text hover:bg-ink/[0.06]">{t("common.undo")}</button>
        </div>
      )}
      {problem && <NoteRow tone="warn">{problem}</NoteRow>}
    </Card>
  );
}
