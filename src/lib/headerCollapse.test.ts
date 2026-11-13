import { describe, expect, it } from "vitest";
import { resolveHeaderCollapse } from "./headerCollapse";
describe("resolveHeaderCollapse", () => {
  it("resolves spacious state for headers >= 640px", () => {
    const state = resolveHeaderCollapse(700);
    expect(state.isSpacious).toBe(true);
    expect(state.isCompact).toBe(false);
    expect(state.isTight).toBe(false);
    expect(state.isVeryTight).toBe(false);
    expect(state.modelMode).toBe("full");
    expect(state.showButtonsText).toBe(true);
    expect(state.collapseSecondaryToMenu).toBe(false);
  });

  it("resolves compact state for headers between 520px and 639px", () => {
    const state = resolveHeaderCollapse(580);
    expect(state.isSpacious).toBe(false);
    expect(state.isCompact).toBe(true);
    expect(state.isTight).toBe(false);
    expect(state.isVeryTight).toBe(false);
    expect(state.modelMode).toBe("compact");
    expect(state.showButtonsText).toBe(false);
    expect(state.collapseSecondaryToMenu).toBe(false);
  });

  it("resolves tight state at 480px (e.g. 1440px viewport dual-docked)", () => {
    const state = resolveHeaderCollapse(480);
    expect(state.isSpacious).toBe(false);
    expect(state.isCompact).toBe(false);
    expect(state.isTight).toBe(true);
    expect(state.isVeryTight).toBe(false);
    expect(state.modelMode).toBe("compact");
    expect(state.showButtonsText).toBe(false);
    expect(state.collapseSecondaryToMenu).toBe(true);
  });

  it("resolves very tight state for narrow headers <= 420px", () => {
    const state = resolveHeaderCollapse(420);
    expect(state.isSpacious).toBe(false);
    expect(state.isCompact).toBe(false);
    expect(state.isTight).toBe(true);
    expect(state.isVeryTight).toBe(true);
    expect(state.modelMode).toBe("iconOnly");
    expect(state.showButtonsText).toBe(false);
    expect(state.collapseSecondaryToMenu).toBe(true);
  });

  it("resolves very tight state at 360px minimum chat width", () => {
    const state = resolveHeaderCollapse(360);
    expect(state.isTight).toBe(true);
    expect(state.isVeryTight).toBe(true);
    expect(state.modelMode).toBe("iconOnly");
    expect(state.collapseSecondaryToMenu).toBe(true);
  });
});
