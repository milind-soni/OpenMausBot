// @vitest-environment happy-dom
// The one "loads a lot" line in simple Bot settings: shown only when the server says the bot is heavy, with Tidy memory.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), heavy: [] as boolean[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));

const { HeavyBotRow } = await import("./HeavyBotRow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const bot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "sonnet" }, ...patch,
});
const render = async (patch?: Partial<Bot>) => { await act(async () => root.render(createElement(HeavyBotRow, { bot: bot(patch) }))); };

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.heavy = [];
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => path.endsWith("/system-prompt") ? { heavy: fixture.heavy.shift() ?? false } : { report: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("stays out of the way while the bot is light", async () => {
  fixture.heavy = [false];
  await render();
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/system-prompt");
  expect(host.querySelector("[data-panel-row=heavy]")).toBeNull();
});

it("says the bot loads a lot, tidies its memory, and goes once it is light again", async () => {
  fixture.heavy = [true, false];
  await render();
  expect(host.querySelector("[data-panel-row=heavy]")?.textContent).toContain("This bot loads a lot every turn.");
  const tidy = host.querySelector<HTMLButtonElement>("[data-panel-action=tidy-memory]")!;
  expect(tidy.textContent).toBe("Tidy memory");
  await act(async () => { tidy.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/memory/tidy", { method: "POST" });
  expect(host.querySelector("[data-panel-row=heavy]")).toBeNull();
});

it("asks nothing when memory or its upkeep is off, since a tidy-up could not run", async () => {
  fixture.heavy = [true, true];
  await render({ memoryUpkeep: false });
  await render({ memoryEnabled: false });
  expect(fixture.api).not.toHaveBeenCalled();
  expect(host.querySelector("[data-panel-row=heavy]")).toBeNull();
});
