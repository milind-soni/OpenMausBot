// @vitest-environment happy-dom
// Simple's Memory page keeps what advanced Memory had: upkeep on or off, the lending review, and Changes with Undo.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { MemoryJournalRow } from "@/lib/memory";
import type { MemoryModelStatus } from "../../../shared/memory-model";

const fixture = vi.hoisted(() => ({
  api: vi.fn(), dispatch: vi.fn(), journal: [] as unknown[], review: undefined as unknown,
  memoryModel: undefined as MemoryModelStatus | undefined,
  upkeepFailed: false,
  afterTidy: undefined as MemoryModelStatus | undefined,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({
    state: { instances: [{ instanceId: "openrouter", models: { options: [{ id: "vendor/next", label: "Next model" }] } }] },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "other" } } }),
}));

const { MemoryUpkeepCards } = await import("./MemoryUpkeepCards");
const { MemorySection } = await import("../bot-settings/MemorySection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onChanged = vi.fn(async () => {});
const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "sonnet" },
};
const row: MemoryJournalRow = {
  id: "j1", at: Date.now() - 60_000, botId: "scout", path: "MEMORY.md", actor: "upkeep", via: "organize", kind: "edited",
  beforeHash: "a", afterHash: "b", diff: "", added: 0, removed: 1, canRevert: true,
};
const render = async () => { await act(async () => root.render(createElement(MemoryUpkeepCards, { bot, onChanged }))); };

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.journal = [];
  fixture.review = undefined;
  fixture.memoryModel = undefined;
  fixture.upkeepFailed = false;
  fixture.afterTidy = undefined;
  onChanged.mockClear();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const overview = { index: { lines: 0, bytes: 0, maxLines: 200, maxBytes: 24_000, loadedLines: 0, loadedBytes: 0, truncated: false },
      topics: [], logs: [], ...(fixture.review ? { lendingReview: fixture.review } : {}) };
    if (path.endsWith("/memory/upkeep")) {
      if (fixture.upkeepFailed) throw new Error("HTTP 503");
      return { enabled: true, modelSteps: true, memoryModel: fixture.memoryModel };
    }
    if (path === "/api/bots/scout" && init?.method === "PATCH") {
      fixture.memoryModel = JSON.parse(String(init.body)).memoryModel ?? { instanceId: "openrouter" };
      return { ok: true };
    }
    if (path.includes("/memory/journal?")) return { entries: fixture.journal };
    if (path.endsWith("/memory")) return overview;
    if (path.includes("/memory/file?")) return { path: "MEMORY.md", text: "", hash: "h" };
    if (path.endsWith("/memory/tidy") && init?.method === "POST") {
      fixture.memoryModel = fixture.afterTidy;
      return { overview, report: { expired: 0, duplicates: 0, superseded: 0 } };
    }
    return { ok: true };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("switches Memory upkeep off and shows no Changes before there are any", async () => {
  await render();
  expect(host.querySelector("[data-panel-row=memory-changes]")).toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-panel-row=memory-upkeep] button")!.click(); });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { memoryUpkeep: false } });
});

it("keeps the selected model visible after fallback and saves an independent memory selection", async () => {
  const selection = { instanceId: "openrouter", model: "vendor/previous" };
  fixture.memoryModel = { ...selection, last: { ...selection, state: "fallback", used: "vendor/auto" } };
  await render();
  const select = host.querySelector<HTMLSelectElement>('[data-panel-row="memory-model"] select')!;
  expect(select.value).toBe(selection.model);
  expect(host.querySelector('[data-panel-row="memory-model"] [role="status"]')?.textContent).toContain("used vendor/auto");

  await act(async () => { select.value = "vendor/next"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", {
    method: "PATCH", body: JSON.stringify({ memoryModel: { instanceId: "openrouter", model: "vendor/next" } }),
  });
  expect(select.value).toBe("vendor/next");
  expect(host.querySelector('[data-panel-row="memory-model"] [role="status"]')).toBeNull();
});

it("does not read upkeep status again as minutes pass while the panel is open", async () => {
  vi.useFakeTimers();
  await render();
  expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/memory/upkeep"))).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/memory/upkeep"))).toHaveLength(1);
});

it("shows a failed status read and lets the person retry", async () => {
  fixture.upkeepFailed = true;
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("HTTP 503");
  fixture.upkeepFailed = false;
  fixture.memoryModel = { instanceId: "openrouter" };
  const retry = [...host.querySelectorAll("button")].find((button) => /retry|try again/i.test(button.textContent ?? ""));
  expect(retry).toBeDefined();
  await act(async () => { retry?.click(); });
  expect(host.querySelector('[data-panel-row="memory-model"] select')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("updates the Advanced Memory model status as soon as Tidy up now completes", async () => {
  const selection = { instanceId: "openrouter", model: "vendor/previous" };
  fixture.memoryModel = { ...selection, last: { ...selection, state: "fallback", used: "vendor/auto" } };
  fixture.afterTidy = { ...selection, last: { ...selection, state: "selected" } };
  await act(async () => root.render(createElement(MemorySection, { bot, onToggle: vi.fn() })));
  expect(host.querySelector('[data-panel-row="memory-model"] [role="status"]')?.textContent).toContain("used vendor/auto");
  expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/memory/upkeep"))).toHaveLength(1);
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Tidy up now")!;
  await act(async () => { button.click(); });
  expect(host.querySelector('[data-panel-row="memory-model"] [role="status"]')).toBeNull();
  expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/memory/upkeep"))).toHaveLength(2);
});

it("undoes an upkeep change from Changes and shows the lending review until it is marked reviewed", async () => {
  fixture.journal = [row];
  fixture.review = { token: "tok", changed: ["MEMORY.md"] };
  await render();
  expect(host.textContent).toContain("Memory upkeep removed 1 line from MEMORY.md");
  const undo = [...host.querySelectorAll("[data-panel-row=memory-changes] button")].find((button) => button.textContent?.includes("Undo"))!;
  await act(async () => { (undo as HTMLButtonElement).click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/memory/journal/j1/revert", { method: "POST" });
  expect(onChanged).toHaveBeenCalled();
  const reviewed = [...host.querySelectorAll("button")].find((button) => button.textContent === "Mark reviewed")!;
  expect(reviewed).toBeTruthy();
  fixture.review = undefined;
  await act(async () => { reviewed.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/memory/reviewed", { method: "POST", body: JSON.stringify({ token: "tok" }) });
});
