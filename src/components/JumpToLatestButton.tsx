import type { CSSProperties } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** A round jump button over the foot of a scroller; `up` and `label` point it at something above instead of the latest. */
export function JumpToLatestButton({ onClick, className, style, up = false, label }: { onClick: () => void; className?: string; style?: CSSProperties; up?: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      type="button"
      aria-label={label ?? t("chat.jumpToLatestAria")}
      title={label ?? t("chat.jumpToLatest")}
      className={cn("animate-pop-in absolute left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-hairline/40 bg-raised text-ink shadow-lg hover:bg-raised-hover", className)}
      style={style}
    >
      {up ? <ArrowUp size={18} aria-hidden="true" /> : <ArrowDown size={18} aria-hidden="true" />}
    </button>
  );
}
