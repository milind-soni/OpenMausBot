import { Code, Eye } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ACTION_ICON } from "@/components/MessageActions";

export interface RawToggleActionProps {
  active: boolean;
  onToggle: () => void;
  className?: string;
}

export function RawToggleAction({ active, onToggle, className }: RawToggleActionProps) {
  const label = t(active ? "chat.showRenderedMarkdown" : "chat.showRawMarkdown");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "rounded-md p-1.5 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        active
          ? "bg-raised text-accent opacity-100"
          : "text-ink-secondary opacity-0 hover:bg-raised hover:text-ink",
        className,
      )}
    >
      {active ? <Eye {...ACTION_ICON} aria-hidden="true" /> : <Code {...ACTION_ICON} aria-hidden="true" />}
    </button>
  );
}

export interface RawMarkdownViewProps {
  text: string;
  className?: string;
}

/** Security: React escapes the source. */
export function RawMarkdownView({ text, className }: RawMarkdownViewProps) {
  return (
    <pre
      dir="auto"
      data-testid="raw-markdown-view"
      tabIndex={0}
      className={cn(
        "max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline/30 bg-inset/50 p-3 font-mono text-[13px] leading-relaxed text-ink select-text",
        className,
      )}
    >
      {text}
    </pre>
  );
}
