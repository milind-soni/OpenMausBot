// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateEverythingState } from "@/types/ogb";
import { UpdateEverything } from "./UpdateEverything";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const ready = (): UpdateEverythingState => ({ revision: 2, phase: "ready", planId: "native-plan", rows: [{ id: "local", name: "This app", providers: ["Codex"], app: "2.0", status: "ready" }] });
const bridge = { state: vi.fn(), check: vi.fn(), run: vi.fn() };
const button = (name: string, scope: ParentNode = host) => Array.from(scope.querySelectorAll("button")).find(b => b.textContent === name)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const mount = async () => { await act(async () => root.render(createElement(UpdateEverything))); };
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  bridge.state.mockReset().mockResolvedValue({ phase: "idle", revision: 0, rows: [] });
  bridge.check.mockReset().mockResolvedValue(ready());
  bridge.run.mockReset().mockResolvedValue({ ...ready(), revision: 3, phase: "complete" });
  Object.defineProperty(window, "ogb", { configurable: true, writable: true, value: { updateEverything: bridge } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.ogb; vi.useRealTimers(); });

it("is absent without the privileged desktop bridge", async () => {
  delete window.ogb; await mount(); expect(host.textContent).toBe("");
});

it("checks, shows the plan, cancels on Escape, then confirms only its native ID", async () => {
  await mount(); await click(button("Check all environments"));
  expect(host.textContent).toContain("Codex"); expect(host.textContent).toContain("2.0");
  const opener = button("Update everything"); opener.focus(); await click(opener);
  expect(document.activeElement?.textContent).toBe("Cancel");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(bridge.run).not.toHaveBeenCalled(); expect(document.activeElement).toBe(opener);
  await click(opener); await click(button("Update everything", document.querySelector('[role="alertdialog"]')!));
  expect(bridge.run).toHaveBeenCalledExactlyOnceWith("native-plan");
  expect(host.textContent).toContain("Eligible updates completed");
});

it("does not let an older polling result replace a reviewed plan", async () => {
  let resolve!: (state: UpdateEverythingState) => void;
  bridge.state.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await mount(); await click(button("Check all environments"));
  await act(async () => resolve({ phase: "idle", revision: 0, rows: [] }));
  expect(host.textContent).toContain("Codex"); expect(button("Update everything")).toBeDefined();
});

it("shows a failed step without claiming completion", async () => {
  bridge.run.mockResolvedValue({ ...ready(), revision: 4, phase: "failed", error: "Fixture installer failed" });
  await mount(); await click(button("Check all environments")); await click(button("Update everything"));
  await click(button("Update everything", document.querySelector('[role="alertdialog"]')!));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Fixture installer failed");
  expect(host.textContent).not.toContain("Eligible updates completed");
});

it("disables duplicate clicks while a check is pending and survives dismissal", async () => {
  let resolve!: (state: UpdateEverythingState) => void;
  bridge.check.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await mount(); await click(button("Check all environments"));
  const pending = button("Working…"); expect(pending.disabled).toBe(true); await click(pending);
  expect(bridge.check).toHaveBeenCalledTimes(1);
  act(() => root.render(null)); await act(async () => resolve(ready()));
  expect(bridge.run).not.toHaveBeenCalled();
});
