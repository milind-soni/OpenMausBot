export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "data";

export function computerPanelTabs(androidConnected: boolean): ComputerPanelView[] {
  const android = androidConnected ? (["android"] as const) : [];
  return ["computer", "routines", ...android, "browser", "data"];
}

export function resolveComputerPanelView(view: ComputerPanelView, androidConnected: boolean): ComputerPanelView {
  return computerPanelTabs(androidConnected).includes(view) ? view : "computer";
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
    if (value === "android" || value === "browser" || value === "routines" || value === "data") return value;
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
