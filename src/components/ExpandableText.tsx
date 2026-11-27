import { useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export const EXPANDABLE_TEXT_LIMIT = 280;

export function expandableTextIsLong(text: string): boolean {
  return text.length > EXPANDABLE_TEXT_LIMIT || text.split("\n").length > 6;
}

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
          className="mt-1 text-[13px] font-medium text-accent hover:underline"
        >
          {expanded ? t("question.showLess") : t("question.showFull")}
        </button>
      )}
    </div>
  );
}
