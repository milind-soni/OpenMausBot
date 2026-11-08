// @vitest-environment happy-dom
// Under simple's instructions editor: memory's Changes list for the instructions, who made each change, and Undo.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { MemoryJournalRow } from "@/lib/memory";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), flushBotPatches: vi.fn(), rows: [] as unknown[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch, flushBotPatches: fixture.flushBotPatches }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));

const { SoulChanges } = await import("./SoulChanges");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "Use metric units.",
  notifications: true, color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "sonnet" },
};
const row = (patch: Partial<MemoryJournalRow>): MemoryJournalRow => ({
  id: "r1", at: Date.now() - 60_000, botId: "scout", path: "SOUL.md", actor: "person", via: "api", kind: "edited",
  beforeHash: null, afterHash: null, diff: "--- a/SOUL.md\n+++ b/SOUL.md\n@@ -1,0 +1,1 @@\n+Use metric units.", added: 1, removed: 0, canRevert: true, ...patch,
});
const render = async () => { await act(async () => root.render(createElement(SoulChanges, { bot }))); };

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.flushBotPatches = vi.fn(async () => null);
  fixture.rows = [];
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => path.includes("/history?view=changes") ? { rows: fixture.rows, revision: "rev-2" } : { bot });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows nothing before the instructions ever changed", async () => {
  await render();
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/history?view=changes&limit=20");
  expect(host.querySelector("[data-panel-row=soul-changes]")).toBeNull();
});

it("says who changed the instructions, the bot, an outside edit or a team setup, and Undo puts the old text back", async () => {
  fixture.rows = [row({ id: "r3", actor: "bot", via: "card:m1" }), row({ id: "r2", via: "disk", added: 0, removed: 1 }), row({ id: "r1", actor: "bot", via: "team-setup" })];
  await render();
  const list = host.querySelector("[data-panel-row=soul-changes]")!;
  expect(list.textContent).toContain("Scout added 1 line to the instructions");
  expect(list.textContent).toContain("You removed 1 line from the instructions");
  expect(list.textContent).toContain("changed outside the app");
  expect(list.textContent).toContain("Team setup added 1 line to the instructions");
  const undo = [...list.querySelectorAll("button")].find((button) => button.textContent?.includes("Undo"))!;
  await act(async () => { undo.click(); });
  expect(fixture.flushBotPatches).toHaveBeenCalledWith("scout");
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/history/rollback", { method: "POST", body: JSON.stringify({ id: "r3", expectedRevision: "rev-2" }) });
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
