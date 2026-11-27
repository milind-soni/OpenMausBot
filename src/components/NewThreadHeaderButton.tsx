import { Plus } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useStoreDispatch } from "@/state/store-select";
import { useBotHasThreads } from "./HeaderThreadTabs";

export function NewThreadHeaderButton({ botId, tabs, switcher }: { botId: string; tabs: boolean; switcher: boolean }) {
  const dispatch = useStoreDispatch();
  const pillHasIt = useBotHasThreads(botId) && switcher;
  if (pillHasIt) return null;
  return (
    <button
      type="button"
      data-new-thread
      onClick={() => dispatch({ type: "newTask", botId })}
      aria-label={t("task.newShort")}
      aria-keyshortcuts="Meta+T Control+T"
      title={t("task.newShort")}
      className={cn(tabs && "md:hidden", "flex size-9 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08] motion-reduce:transition-none")}
    >
      <Plus size={16} aria-hidden="true" />
    </button>
  );
}
