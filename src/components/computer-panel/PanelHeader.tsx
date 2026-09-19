import { CalendarClock, Globe, Monitor, Settings, Smartphone, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent, RefObject } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effectivePlace, isComputerPlace } from "@/lib/place";
import type { ComputerPanelView } from "@/lib/computer-panel-view";
import { PANEL_MAX_WIDTH_VALUE, PANEL_MIN_WIDTH_VALUE } from "./usePanelWidth";

/** The panel's chrome: the resize handle, the settings/close buttons, and
 * the tab strip for Computer/Routines/Android/Browser with each live-place
 * dot. */
export function PanelHeader({
  padClass,
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
  separatorRef,
  separatorWidth,
  onSeparatorKeyDown,
}: {
  padClass: string | undefined;
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
  separatorRef: RefObject<HTMLDivElement | null>;
  separatorWidth: number | null;
  onSeparatorKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <>
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH_VALUE}
        aria-valuemax={PANEL_MAX_WIDTH_VALUE}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60"
      />
      {/* Header */}
      <div className={cn("flex items-center justify-between px-4 py-3", padClass)}>
        <button
          onClick={onOpenBotSettings}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title={t("computer.botSettings")}
        >
          <Settings size={18} />
        </button>
        {(
          <div className="mx-2 flex min-w-0 flex-wrap overflow-hidden rounded-lg border border-hairline/40" data-tour="computer-tabs" aria-label="Bot panel view">
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
        onClick={onClose}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>
    </>
  );
}
