import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";

export function ComposerSendButton({ label, title, disabled, onSend }: {
  label: string;
  title: string;
  disabled: boolean;
  onSend: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full disabled:cursor-default",
        "size-8 max-md:size-9",
        "bg-composer-action text-composer-action-ink hover:opacity-90",
      )}
    >
      <ArrowUp size={16} strokeWidth={1.75} absoluteStrokeWidth />
    </button>
  );
}
