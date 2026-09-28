import { Check, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { placeLabelKey, type Place } from "@/lib/place";
import { nameIsCommand } from "@/lib/verify-steps";
import { PlaceIcon } from "./PlaceIcon";
import { WorkingDots } from "./WorkingIndicator";

/** A quiet disclosure, not a second inspector. Old messages and providers
 * without output keep their status and never invent a successful result. */
/** `place` names where a screen or page tool ran, so a transcript shows the
 * place of every step, not just the current one. Absent for tools that touch
 * no screen. */
export function ToolActivity({ tool, place = null }: { tool: NonNullable<Message["tool"]>; place?: Place | null }) {
  const [expanded, setExpanded] = useState(false);
  const failed = tool.ok === false;
  const status = tool.ok === undefined ? t("toolDetail.running") : failed ? t("toolDetail.failed") : t("toolDetail.completed");
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="group/tool w-fit max-w-full rounded-xl border border-hairline/40 bg-panel text-[13px] open:w-[min(38rem,100%)]" data-testid="tool-activity">
      <summary
        role="button"
        aria-expanded={expanded}
        aria-label={t("toolDetail.label", { name: tool.name, status })}
        className={cn("flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1.5 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden", failed ? "text-danger" : "text-ink-secondary")}
      >
        <span className="shrink-0" aria-hidden="true">{tool.ok === undefined ? <WorkingDots size={3.5} /> : failed ? <X size={13} /> : <Check size={13} className="text-success" />}</span>
        {place && <PlaceIcon place={place} size={13} className="shrink-0 opacity-70" role="img" aria-label={t(placeLabelKey(place))} data-testid="tool-place" />}
        <span className="min-w-0 max-w-[30rem] truncate font-mono">{tool.name}</span>
        {tool.summary && tool.summary !== tool.name && !nameIsCommand(tool.name) && <span className="min-w-0 flex-1 truncate font-mono" title={tool.summary}>{tool.summary}</span>}
        <ChevronRight size={13} className="ml-auto shrink-0 group-open/tool:rotate-90" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-hairline/40 p-3 text-ink-secondary">
        <div className={cn("text-[11px] font-medium", failed && "text-danger")}>{status}</div>
        <div>
          <div className="mb-1 text-[11px] font-medium">{t("toolDetail.input")}</div>
          <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.input ?? tool.summary ?? tool.name}</pre>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium">{t("toolDetail.output")}</div>
          {tool.output ? <pre dir="ltr" className="max-h-64 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.output}</pre> : <p className="text-xs">{tool.ok === undefined ? t("toolDetail.waiting") : t("toolDetail.noOutput")}</p>}
        </div>
        <p className="text-[11px] text-ink-secondary">{t("toolDetail.previewHint")}</p>
      </div>
    </details>
  );
}
