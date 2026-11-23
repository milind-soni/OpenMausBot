import type { SavedWorkflow } from "@/lib/skill-burger";
import { cn } from "@/lib/cn";
import { LayerIcon, sliceTint } from "./SkillBurger";

const SLICES = 3;

/** A saved Skill Burger in miniature: two buns and its first few steps as thin tinted slices, each with its app's mark. */
export function MiniBurger({ skill, size = "md" }: { skill: Pick<SavedWorkflow, "layers">; size?: "sm" | "md" }) {
  const slices = skill.layers.slice(0, SLICES);
  const width = size === "sm" ? "w-12" : "w-[72px]";
  return (
    <span aria-hidden="true" className={cn("skill-burger flex shrink-0 flex-col gap-[2px]", width)}>
      <span className="burger-bun burger-bun-top relative block h-3.5" />
      {slices.map((layer, index) => (
        <span key={index} style={sliceTint(layer)} className={cn("burger-layer burger-mini-slice flex items-center justify-center", size === "sm" ? "h-3.5" : "h-[18px]")}>
          <span className={cn("flex items-center justify-center", size === "sm" ? "scale-[0.7]" : "scale-[0.8]")}><LayerIcon kind={layer.kind} app={layer.app} /></span>
        </span>
      ))}
      <span className="burger-bun burger-bun-bottom block h-2.5" />
    </span>
  );
}
