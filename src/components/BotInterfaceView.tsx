import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { ChatHeadPill } from "./ChatHeadPill";
import { useCaptionChrome } from "./DesktopCapabilities";
import { ELEVATED_FLOAT } from "./elevated";
import { Segmented } from "./SettingsPrimitives";

export function BotViewSwitcher({ botId, view, enabled = true, children }: {
  botId: string;
  enabled?: boolean;
  view: "chat" | "ui-interface";
  children: ReactNode;
}) {
  const dispatch = useStoreDispatch();
  if (!enabled) return children;
  return (
    <div data-bot-view-switcher="" className={cn("flex min-w-0 max-w-full items-center gap-1 rounded-full pe-1 [&>:first-child]:shadow-none [&>:first-child]:ring-0", ELEVATED_FLOAT)}>
      {children}
      <Segmented
        label={t("botPanel.uiInterface.view")}
        value={view}
        options={[{ value: "chat", label: t("settings.appearance.chat") }, { value: "ui-interface", label: t("botPanel.uiInterface.ui") }]}
        onChange={(next) => dispatch(next === "chat" ? { type: "showChat" } : { type: "showBotInterface", botId })}
      />
    </div>
  );
}

export function BotInterfaceView({ bot }: { bot: Bot }) {
  const dispatch = useStoreDispatch();
  const settingsOpen = useStoreSelector((state) => state.settingsOpen);
  const { dragProps, noDragStyle } = useCaptionChrome();
  return (
    <main aria-label={t("botPanel.uiInterface")} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div {...dragProps} className="absolute inset-x-0 top-0 flex justify-center px-5 py-2.5 max-md:ps-14 max-md:pe-3">
        <div style={noDragStyle} className="min-w-0 max-w-full">
          <BotViewSwitcher botId={bot.id} view="ui-interface">
            <ChatHeadPill bot={bot} avatar={{}} privacy={null} onToggle={() => dispatch({ type: "toggleSettings", open: !settingsOpen })} />
          </BotViewSwitcher>
        </div>
      </div>
      <div data-bot-interface-page="" className="min-h-0 w-full flex-1" />
    </main>
  );
}
