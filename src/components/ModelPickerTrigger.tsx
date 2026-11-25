import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { modelName, variantSuffix } from "@/lib/simple-model-menu";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "./elevated";
import { UsageBars } from "./EngineUsage";
import { InstanceProviderMark } from "./ProviderIcons";

/** Simple mode's model button: the AI's mark, then the model, its reasoning and usage bars and a chevron.
 *
 * In the chat header, `folded` (a side panel narrows the chat) leaves only the mark, in a round button the size of the
 * header's others; `summary` then names the model for screen readers. styles.css (`[data-model-pill]`) glides the
 * width and eases the words out and back in; the fold is off with reduced motion. */
export function SimpleModelTrigger({ active, selection, attention, contained, size, folded = false, summary, className, ...button }: ComponentProps<"button"> & {
  active: InstanceInfo | undefined;
  selection: ModelSelection;
  attention: string | undefined;
  contained: boolean;
  size: "sm" | "md";
  folded?: boolean;
  summary: string;
}) {
  const header = !contained && size === "md";
  return (
    <button
      {...button}
      data-model-pill={header ? "" : undefined}
      data-folded={header && folded ? "" : undefined}
      aria-label={header && folded ? summary : undefined}
      className={cn(
        "group flex items-center rounded-full text-[13px] leading-[18px] text-ink-secondary disabled:cursor-not-allowed disabled:text-ink-tertiary",
        contained
          ? "min-w-0 max-w-[72%] transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08] aria-expanded:text-ink disabled:hover:bg-transparent"
          : cn("shrink-0", ELEVATED_FLOAT, ELEVATED_HOVER, "hover:text-ink aria-expanded:text-ink disabled:hover:bg-composer"),
        size === "sm" ? "h-7 pl-2 pr-1.5" : contained ? "h-8 pl-2.5 pr-2" : "h-9 min-w-9 justify-center pl-3 pr-2.5",
        className,
      )}
    >
      <span data-model-pill-mark={header ? "" : undefined} className="relative me-1.5 flex shrink-0 group-disabled:opacity-50">
        {active
          ? <InstanceProviderMark instance={active} size={14} subtle />
          : <span className="size-3.5 rounded-full bg-ink/[0.08]" aria-hidden="true" />}
        {attention && <span data-model-attention className="absolute -bottom-0.5 -end-0.5 size-1.5 rounded-full bg-warning ring-[1.5px] ring-app" />}
      </span>
      {/* The fold's track: a grid column going from 1fr to 0fr shrinks the pill to its mark without measuring it. */}
      <span data-model-pill-rest={header ? "" : undefined} className={cn("min-w-0", header ? "grid" : "contents")}>
        <span className={header ? "flex min-w-0 items-center overflow-hidden whitespace-nowrap" : "contents"}>
          <span data-model-pill-words={header ? "" : undefined} className={cn("min-w-0 truncate", !contained && "max-w-[160px]")}>{modelName(active, selection.model)}</span>
          {selection.variant !== undefined && <span data-model-pill-words={header ? "" : undefined} className="shrink-0 whitespace-pre">{variantSuffix(active, selection.model, selection.variant)}</span>}
          <span data-model-pill-tail={header ? "" : undefined} className={header ? "flex shrink-0 items-center" : "contents"}>
            <UsageBars engine={selection.instanceId} className="ms-1.5" />
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="ms-1 shrink-0 text-ink-tertiary group-hover:text-ink-secondary" />
          </span>
        </span>
      </span>
    </button>
  );
}
