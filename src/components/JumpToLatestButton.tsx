import type { CSSProperties } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function JumpToLatestButton({ onClick, className, style }: { onClick: () => void; className?: string; style?: CSSProperties }) {
  return (
    <button
      onClick={onClick}
      type="button"
      aria-label={t("chat.jumpToLatestAria")}
      title={t("chat.jumpToLatest")}
      className={cn("animate-pop-in absolute left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-hairline/40 bg-raised text-ink shadow-lg hover:bg-raised-hover", className)}
      style={style}
    >
      <ArrowDown size={18} aria-hidden="true" />
    </button>
  );
}
