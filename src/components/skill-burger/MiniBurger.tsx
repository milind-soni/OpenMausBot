import type { SavedWorkflow } from "@/lib/skill-burger";
import { cn } from "@/lib/cn";
import { LayerIcon } from "./SkillBurger";

const SHOWN = 3;

/** A saved Skill Burger at a glance: its first few steps' marks, stacked in small plain tiles. */
export function MiniBurger({ skill, size = "md" }: { skill: Pick<SavedWorkflow, "layers">; size?: "sm" | "md" }) {
  const steps = skill.layers.slice(0, SHOWN);
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 flex-col gap-[3px]", size === "sm" ? "w-7" : "w-9")}>
      {steps.map((layer, index) => (
        <span key={index} className={cn("flex items-center justify-center rounded-md bg-card shadow-sm", size === "sm" ? "h-5" : "h-7")}>
          <span className={cn("flex items-center justify-center", size === "sm" ? "scale-[0.75]" : "scale-90")}><LayerIcon kind={layer.kind} app={layer.app} /></span>
        </span>
      ))}
    </span>
  );
}
