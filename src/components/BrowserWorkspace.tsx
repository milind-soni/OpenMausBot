// The Browser tab, expanded: the same native view the panel shows, given the
// whole main column. Opened by clicking the small preview in the computer
// panel; closing hands the tab back to the panel. Control (Take control /
// Hand back) is the same lease the panel uses, so a hold survives the swap.
import { Globe, X } from "lucide-react";
import type { Bot } from "@/state/store";
import { useBrowserControl } from "@/hooks/use-browser-control";
import { BrowserPanel } from "./BrowserPanel";

export function BrowserWorkspace({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { control, controlPending, controlAction, error } = useBrowserControl(bot.id);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-[60px] items-center gap-3 border-b border-hairline/40 px-5 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Globe size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold text-ink">{bot.name}'s browser</h1>
          <p className="truncate text-[11.5px] text-ink-secondary">
            Live page · click into it to take over · the bot pauses while you drive
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Back to the small browser"
          title="Back to the panel"
        >
          <X size={18} />
        </button>
      </header>
      {error && <div role="alert" className="mx-5 mt-3 text-[12px] text-danger">{error}</div>}
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
        <BrowserPanel
          bot={bot}
          control={control}
          controlPending={controlPending}
          onControl={controlAction}
          size="expanded"
          onCollapse={onClose}
        />
      </div>
    </main>
  );
}
