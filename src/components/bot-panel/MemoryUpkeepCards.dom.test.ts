// @vitest-environment happy-dom
// Simple's Memory page keeps what advanced Memory had: upkeep on or off, the lending review, and Changes with Undo.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { MemoryJournalRow } from "@/lib/memory";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), journal: [] as unknown[], review: undefined as unknown }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));

const { MemoryUpkeepCards } = await import("./MemoryUpkeepCards");

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
  onChanged.mockClear();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    if (path.includes("/memory/journal?")) return { entries: fixture.journal };
    if (path.endsWith("/memory")) return { index: {}, topics: [], logs: [], ...(fixture.review ? { lendingReview: fixture.review } : {}) };
    return { ok: true };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("switches Memory upkeep off and shows no Changes before there are any", async () => {
  await render();
  expect(host.querySelector("[data-panel-row=memory-changes]")).toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-panel-row=memory-upkeep] button")!.click(); });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { memoryUpkeep: false } });
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
