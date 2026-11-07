import { Monitor } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";
import { screenToolLive, type EffectivePlace } from "@/lib/place";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** A "Watch" pill in the chat header while a running tool call is using the bot's screen and the Screen panel is
 * closed, so the person can see what the bot is doing without hunting for the monitor button. */
export function WatchScreenButton({ botId, messages, liveTools, place }: { botId: string; messages: readonly Message[]; liveTools: ReadonlySet<string>; place: EffectivePlace }) {
  const { state, dispatch } = useStore();
  if (state.computerOpen || !screenToolLive(messages, liveTools, place)) return null;
  return (
    <button
      data-testid="watch-screen"
      onClick={(event) => { rememberComputerPanelOpen({ botId, opener: event.currentTarget, tabs: event.detail === 0 }); dispatch({ type: "toggleComputer", open: true }); }}
      className={cn("flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink", COMPACT_BUBBLE)}
      title={t("chat.watchScreenHint")}
    >
      <Monitor size={13} aria-hidden="true" />
      <span>{t("chat.watchScreen")}</span>
    </button>
  );
}
