import { CalendarClock, Globe, Monitor, Settings, Smartphone, X } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effectivePlace, isComputerPlace } from "@/lib/place";
import type { ComputerPanelView } from "@/lib/computer-panel-view";

/** The panel's chrome: the resize handle, the settings/close buttons, and
 * the tab strip for Computer/Routines/Android/Browser with each live-place
 * dot. */
export function PanelHeader({
  padClass,
  panelWidth,
  panelMinWidth,
  panelMaxWidth,
  panelView,
  selectPanelView,
  placeLive,
  livePlace,
  androidConnected,
  browserEnabled,
  onOpenBotSettings,
  onSelectBrowser,
  onClose,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
}: {
  padClass: string | undefined;
  panelWidth: number;
  panelMinWidth: number;
  panelMaxWidth: number;
  panelView: ComputerPanelView;
  selectPanelView: (view: ComputerPanelView) => void;
  placeLive: boolean;
  livePlace: ReturnType<typeof effectivePlace>;
  androidConnected: boolean;
  browserEnabled: boolean;
  onOpenBotSettings: () => void;
  onSelectBrowser: () => void;
  onClose: () => void;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={panelMinWidth}
        aria-valuemax={panelMaxWidth}
        aria-valuenow={panelWidth}
        tabIndex={0}
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60"
      />
      {/* Header */}
      <div className={cn("flex items-center justify-between px-4 py-3", padClass)}>
        <button
          type="button"
          onClick={onOpenBotSettings}
          aria-label={t("computer.botSettings")}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title={t("computer.botSettings")}
        >
          <Settings size={18} />
        </button>
        {(
          <div className="mx-2 flex min-w-0 flex-wrap overflow-hidden rounded-lg border border-hairline/40" data-tour="computer-tabs" aria-label={t("computer.tabsAria")}>
            <button
              onClick={() => selectPanelView("computer")}
              aria-pressed={panelView === "computer"}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]",
                panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Monitor size={13} /> {t("computer.tab.computer")}
              {placeLive && isComputerPlace(livePlace) && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid="computer-tab-live" />}
            </button>
            <button
              type="button"
              onClick={() => selectPanelView("routines")}
              aria-pressed={panelView === "routines"}
              className={cn("flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]", panelView === "routines" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink")}
            ><CalendarClock size={13} />{t("computer.tab.routines")}</button>
            {androidConnected && (
            <button
              onClick={() => selectPanelView("android")}
              aria-pressed={panelView === "android"}
              className={cn(
                "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Smartphone size={13} /> {t("computer.tab.android")}
            </button>
            )}
            {browserEnabled && (
            <button
              data-tour="computer-browser"
              onClick={onSelectBrowser}
              aria-pressed={panelView === "browser"}
              className={cn(
                "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                panelView === "browser" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Globe size={13} /> {t("computer.tab.browser")}
              {placeLive && livePlace === "browser" && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid="browser-tab-live" />}
            </button>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title={t("common.close")}
        >
          <X size={18} />
        </button>
      </div>
    </>
  );
}
