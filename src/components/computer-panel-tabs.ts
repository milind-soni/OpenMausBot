import { useEffect, type KeyboardEvent, type WheelEvent } from "react";
import { CalendarClock, Database, FolderOpen, Globe, Monitor, Smartphone, type LucideIcon } from "lucide-react";
import { readComputerPanelView, writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import type { AndroidUsbDevicesStatus } from "./AndroidDevicePanel";
import type { LocaleKey } from "@/locales";

export const PANEL_TABS: Record<ComputerPanelView, { Icon: LucideIcon; label: LocaleKey; tour?: string }> = {
  computer: { Icon: Monitor, label: "computer.tab.computer" },
  routines: { Icon: CalendarClock, label: "computer.tab.routines" },
  android: { Icon: Smartphone, label: "computer.tab.android" },
  browser: { Icon: Globe, label: "computer.tab.browser", tour: "computer-browser" },
  data: { Icon: Database, label: "computer.tab.data", tour: "computer-data" },
  files: { Icon: FolderOpen, label: "computer.tab.files" },
};

export const TAB_PANEL_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";

const tabId = (view: ComputerPanelView) => `computer-panel-tabs-tab-${view}`;
const panelId = (view: ComputerPanelView) => `computer-panel-tabs-panel-${view}`;

export const panelTabProps = (view: ComputerPanelView, selected: boolean) => ({
  id: tabId(view),
  role: "tab",
  "aria-selected": selected,
  "aria-controls": panelId(view),
  tabIndex: selected ? 0 : -1,
}) as const;

export const tabPanelProps = (view: ComputerPanelView) => ({
  role: "tabpanel",
  id: panelId(view),
  "aria-labelledby": tabId(view),
  tabIndex: 0,
}) as const;

/** A plain mouse wheel only scrolls vertically: over a tab row too narrow for its tabs it scrolls the row
 * sideways. No preventDefault: React's wheel listeners are passive, and nothing behind the row scrolls. */
export function scrollTabsWithWheel(event: WheelEvent<HTMLElement>): void {
  const row = event.currentTarget;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || row.scrollWidth <= row.clientWidth) return;
  row.scrollLeft += event.deltaY;
}

export function moveBetweenTabs(
  event: KeyboardEvent<HTMLElement>,
  tabs: readonly ComputerPanelView[],
  select: (view: ComputerPanelView) => void,
): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const at = Math.max(0, tabs.findIndex((view) => tabId(view) === (event.target as HTMLElement).id));
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  const next = event.key === "Home" ? tabs[0]
    : event.key === "End" ? tabs[tabs.length - 1]
    : step ? tabs[(at + step + tabs.length) % tabs.length]
    : undefined;
  if (!next) return;
  event.preventDefault();
  select(next);
  document.getElementById(tabId(next))?.focus();
}

export function useAndroidTabFallback(
  botId: string,
  status: AndroidUsbDevicesStatus,
  setView: (view: ComputerPanelView) => void,
): void {
  // A failed or missing adb also reports no devices, so only a clean check proves the phone is gone.
  const confirmedGone = status.scanned && status.devices.length === 0
    && status.reasonCode !== "adb-unavailable" && status.reasonCode !== "adb-failed";
  useEffect(() => {
    // Read storage, not render state: a focus effect in the same commit may have stored a newer view.
    if (!confirmedGone || readComputerPanelView(botId) !== "android") return;
    setView("computer");
    writeComputerPanelView(botId, "computer");
  }, [botId, confirmedGone, setView]);
}
