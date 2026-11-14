export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "files" | "data";

type PanelTabsContext = { advanced: boolean; androidConnected: boolean };

export function computerPanelTabs({ advanced, androidConnected }: PanelTabsContext): ComputerPanelView[] {
  const android = androidConnected ? (["android"] as const) : [];
  return advanced
    ? ["computer", "routines", ...android, "browser", "data"]
    : ["computer", ...android, "browser", "data", "files"];
}

export function resolveComputerPanelView(view: ComputerPanelView, context: PanelTabsContext): ComputerPanelView {
  return computerPanelTabs(context).includes(view) ? view : "computer";
}

const STORAGE_PREFIX = "omb-computer-panel-view";

function storageKey(botId: string): string {
  return `${STORAGE_PREFIX}:${botId}`;
}

export function readComputerPanelView(
  botId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): ComputerPanelView {
  try {
    const value = storage.getItem(storageKey(botId));
    if (value === "android" || value === "browser" || value === "routines" || value === "files" || value === "data") return value;
  } catch {
  }
  return "computer";
}

export function writeComputerPanelView(
  botId: string,
  view: ComputerPanelView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey(botId), view);
  } catch {
  }
}
