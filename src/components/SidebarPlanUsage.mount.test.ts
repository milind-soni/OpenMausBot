// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: fixture.api,
  useStore: () => ({ state: { config: {} }, dispatch: () => {} }),
}));

const { setSidebarPlanUsage } = await import("@/lib/sidebar-preferences");
const { SidebarPlanUsage } = await import("./SidebarPlanUsage");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let answer: (report: unknown) => void;

const report = { providers: [{
  id: "Claude", name: "Claude", driver: "claude", ok: true,
  fiveHour: { available: true, usedPercent: 42, remainingPercent: 58 }, weekly: { available: true, usedPercent: 83, remainingPercent: 17 },
}] };

beforeEach(() => {
  setSidebarPlanUsage(true);
  fixture.api.mockReset();
  fixture.api.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows the plan once its answer lands, even when StrictMode restarts the effect first", async () => {
  act(() => root.render(createElement(StrictMode, null, createElement(SidebarPlanUsage))));
  await act(async () => answer(report));
  expect(host.querySelector('[data-sidebar-plan-usage="ok"]')?.getAttribute("aria-label")).toContain("Claude");
});

it("draws nothing and asks for nothing once the person hides it", async () => {
  setSidebarPlanUsage(false);
  act(() => root.render(createElement(SidebarPlanUsage)));
  expect(host.innerHTML).toBe("");
  expect(fixture.api).not.toHaveBeenCalled();
});
