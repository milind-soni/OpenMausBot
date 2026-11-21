// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentCursorOverlayRow } from "./AgentCursorOverlayRow";

it("shows the saved cursor choice and keeps it selected if a save fails", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const set = vi.fn<(enabled: boolean) => Promise<boolean>>()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValueOnce(false);
  try {
    await act(async () => root.render(createElement(AgentCursorOverlayRow)));
    expect(host.querySelector('[role="switch"]')).toBeNull();

    Object.assign(window, { ogb: { agentCursorOverlay: { get: async () => true, set } } });
    await act(async () => root.render(createElement(AgentCursorOverlayRow)));
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Restart the app");

    await act(async () => toggle.click());
    expect(set).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    delete (window as { ogb?: unknown }).ogb;
  }
});
