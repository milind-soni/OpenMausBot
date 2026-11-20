import { Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function BotDeleteMenuItem({ deleting, onClick, className = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]" }: { deleting: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      disabled={deleting}
      aria-busy={deleting || undefined}
      onClick={onClick}
      title={deleting ? t("sidebar.bot.deleteCheckingTitle") : undefined}
      className={cn(
        className,
        "text-danger",
        deleting ? "cursor-default opacity-40" : "hover:bg-menu-hover",
      )}
    >
      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      {deleting ? t("sidebar.bot.deleteChecking") : t("common.delete")}
    </button>
  );
}
