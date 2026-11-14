import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ResizeHandle } from "@/components/ResizeHandle";
import { getStoredPanelWidth, setStoredPanelWidth } from "./usePanelResize";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
vi.stubGlobal("window", {
  innerWidth: 1440,
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
});

describe("usePanelResize storage and helpers", () => {
  beforeEach(() => {
    store.clear();
  });

  it("stores and retrieves panel width from localStorage", () => {
    expect(getStoredPanelWidth("sidebar", 320)).toBe(320);
    setStoredPanelWidth("sidebar", 280);
    expect(getStoredPanelWidth("sidebar", 320)).toBe(280);
  });

  it("falls back to default if localStorage is invalid or empty", () => {
    localStorage.setItem("gbs-panel-width-preview", "not-a-number");
    expect(getStoredPanelWidth("preview", 380)).toBe(380);

    localStorage.setItem("gbs-panel-width-preview", "-50");
    expect(getStoredPanelWidth("preview", 380)).toBe(380);
  });

  it("evaluates defaultWidth when provided as a function", () => {
    const fn = () => 420;
    expect(getStoredPanelWidth("non-existent", fn)).toBe(420);
  });
});

describe("ResizeHandle component accessibility and structure", () => {
  it("renders with proper separator ARIA attributes", () => {
    const markup = renderToStaticMarkup(
      createElement(ResizeHandle, {
        edge: "left",
        width: 380,
        minWidth: 320,
        maxWidth: 600,
        label: "Resize quick preview panel",
        isDragging: false,
        onPointerDown: () => {},
        onPointerMove: () => {},
        onPointerUp: () => {},
        onPointerCancel: () => {},
        onLostPointerCapture: () => {},
        onDoubleClick: () => {},
        onKeyDown: () => {},
      }),
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-valuenow="380"');
    expect(markup).toContain('aria-valuemin="320"');
    expect(markup).toContain('aria-valuemax="600"');
    expect(markup).toContain('aria-label="Resize quick preview panel"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('cursor-col-resize');
    expect(markup).toContain('-left-[4px]');
  });

  it("renders right-edge handle correctly", () => {
    const markup = renderToStaticMarkup(
      createElement(ResizeHandle, {
        edge: "right",
        width: 320,
        minWidth: 240,
        maxWidth: 480,
        label: "Resize sidebar",
        isDragging: false,
        onPointerDown: () => {},
        onPointerMove: () => {},
        onPointerUp: () => {},
        onPointerCancel: () => {},
        onLostPointerCapture: () => {},
        onDoubleClick: () => {},
        onKeyDown: () => {},
      }),
    );

    expect(markup).toContain('-right-[4px]');
    expect(markup).toContain('aria-label="Resize sidebar"');
  });
});
