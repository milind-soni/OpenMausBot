// @vitest-environment happy-dom
// The memory upkeep model picker is an Advanced control: Simple shows neither the picker nor its status line.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { MemoryModelStatus } from "../../../shared/memory-model";

const fixture = vi.hoisted(() => ({ advanced: true, api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/state/store-select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store-select")>()),
  useStoreSelector: (select: (state: unknown) => unknown) =>
    select({ instances: [{ instanceId: "openrouter", models: { options: [{ id: "vendor/next", label: "Next model" }] } }] }),
}));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/interface-mode")>()),
  useAdvancedMode: () => fixture.advanced,
  readAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

const { setLocale } = await import("@/lib/i18n");
const { MemoryModelSetting } = await import("./MemoryModelSetting");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "scout", modelSelection: { instanceId: "openrouter", model: "vendor/auto" } } as unknown as Bot;
const selection = { instanceId: "openrouter", model: "vendor/previous" };
const memoryModel: MemoryModelStatus = { ...selection, last: { ...selection, state: "fallback", used: "vendor/auto" } };
const upkeep = { status: { enabled: true, modelSteps: true, memoryModel }, readError: null, reload: vi.fn(async () => {}) };

let host: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => root.render(createElement(MemoryModelSetting, { bot, upkeep }))); };

beforeEach(() => {
  setLocale("en");
  fixture.advanced = true;
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows the picker and what the last request used in Advanced, and saves a choice", async () => {
  await render();
  const select = host.querySelector<HTMLSelectElement>('[data-panel-row="memory-model"] select')!;
  expect(select.value).toBe("vendor/previous");
  expect(host.querySelector('[data-panel-row="memory-model"] [role="status"]')?.textContent).toContain("used vendor/auto");
  await act(async () => { select.value = "vendor/next"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", {
    method: "PATCH", body: JSON.stringify({ memoryModel: { instanceId: "openrouter", model: "vendor/next" } }),
  });
});

it("draws nothing in Simple: no picker and no status line", async () => {
  fixture.advanced = false;
  await render();
  expect(host.querySelector('[data-panel-row="memory-model"]')).toBeNull();
  expect(host.textContent).toBe("");
});
