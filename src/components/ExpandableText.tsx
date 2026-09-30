import { useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** A question longer than this is collapsed until the person opens it.
 * Short asks stay fully visible, with no extra control. */
export const EXPANDABLE_TEXT_LIMIT = 280;

export function expandableTextIsLong(text: string): boolean {
  return text.length > EXPANDABLE_TEXT_LIMIT || text.split("\n").length > 6;
}

/** Collapsed text is clamped. Expanded text is the whole string: no clamp,
 * no max height, and no overflow clipping. */
export function expandableTextClass(expanded: boolean): string {
  return expanded
    ? "whitespace-pre-wrap break-words"
    : "line-clamp-4 whitespace-pre-wrap break-words";
}

export function ExpandableText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = expandableTextIsLong(text);
  return (
    <div>
      <div className={cn(className, expandableTextClass(long ? expanded : true))}>{text}</div>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-1 text-[12.5px] font-medium text-accent hover:underline"
        >
          {expanded ? t("question.showLess") : t("question.showFull")}
        </button>
      )}
    </div>
  );
}
