import { describe, expect, it } from "vitest";
import { parseLastView, restoreView, viewOf, type ViewState } from "./lastView";

const base: ViewState = {
  selectedId: "",
  schedulesOpen: false,
  projectsOpen: false,
  taskBoardOpen: false,
  previewOpen: false,
  appsOpen: false,
  appSettingsOpen: false,
};

describe("last view", () => {
  it("records the open room and screen", () => {
    expect(viewOf({ ...base, selectedId: "room-1" })).toEqual({ selectedId: "room-1", screen: "chat" });
    expect(viewOf({ ...base, selectedId: "bot-1", taskBoardOpen: true })).toEqual({ selectedId: "bot-1", screen: "tasks" });
    expect(viewOf({ ...base, selectedId: "bot-1", appSettingsOpen: true, appSettingsTab: "models" })).toEqual({
      selectedId: "bot-1",
      screen: "settings",
      settingsTab: "models",
    });
  });

  it("round-trips through storage and reopens the same place", () => {
    const saved = JSON.stringify(viewOf({ ...base, selectedId: "room-7", previewOpen: true }));
    const restored = restoreView(base, parseLastView(saved));
    expect(restored.selectedId).toBe("room-7");
    expect(restored.previewOpen).toBe(true);
    expect(restored.schedulesOpen).toBe(false);
  });

  it("ignores missing or malformed data", () => {
    expect(parseLastView(null)).toBeNull();
    expect(parseLastView("{oops")).toBeNull();
    expect(parseLastView(JSON.stringify({ selectedId: "x", screen: "elsewhere" }))).toBeNull();
    expect(restoreView(base, null)).toBe(base);
  });
});
