// @vitest-environment happy-dom
// Simple's Bot settings switch for a bot's automatic memory, and how Settings → Features turns it off for every bot.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: null as Partial<ConfigStatus> | null, dispatch: vi.fn(), admin: true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

const { MemoryUpkeepRow } = await import("./MemoryUpkeepRow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const bot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "sonnet" }, ...patch,
});
const render = async (patch?: Partial<Bot>) => { await act(async () => root.render(createElement(MemoryUpkeepRow, { bot: bot(patch), onChange }))); };
const row = () => host.querySelector("[data-panel-row=memory-upkeep]");
const toggle = () => host.querySelector<HTMLButtonElement>("[data-panel-row=memory-upkeep] [role=switch]")!;
const features = (memoryUpkeep?: boolean) => ({ features: { skillAuthoring: true, ...(memoryUpkeep === undefined ? {} : { memoryUpkeep }) } }) as Partial<ConfigStatus>;

beforeEach(() => {
  fixture.config = features(true);
  fixture.dispatch = vi.fn();
  fixture.admin = true;
  onChange.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows the bot's own switch on, says what it does, and turns it off for this bot", async () => {
  await render();
  expect(row()?.textContent).toContain("Automatic memory");
  expect(row()?.textContent).toContain("When off, it saves only what you ask it to.");
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(toggle().disabled).toBe(false);
  await act(async () => { toggle().click(); });
  expect(onChange).toHaveBeenCalledWith(false);
});

it("turns a bot's switch back on, and counts an old server that sends no setting for all bots as on", async () => {
  fixture.config = features();
  await render({ memoryUpkeep: false });
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => { toggle().click(); });
  expect(onChange).toHaveBeenCalledWith(true);
});

it("shows off and locked while it is off for all bots, and opens Features", async () => {
  fixture.config = features(false);
  await render();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(toggle().disabled).toBe(true);
  expect(row()?.textContent).toContain("Off for all bots.");
  const open = host.querySelector<HTMLButtonElement>("[data-panel-action=memory-upkeep-features]")!;
  expect(open.textContent).toBe("Open Features");
  await act(async () => { open.click(); });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "features" });
  expect(onChange).not.toHaveBeenCalled();
});

it("offers no Features link to a team member who cannot change it", async () => {
  fixture.config = { ...features(false), team: { id: "t" } } as unknown as Partial<ConfigStatus>;
  fixture.admin = false;
  await render();
  expect(row()?.textContent).toContain("Off for all bots.");
  expect(host.querySelector("[data-panel-action=memory-upkeep-features]")).toBeNull();
});

it("stays hidden when the bot has no memory at all", async () => {
  await render({ memoryEnabled: false });
  expect(row()).toBeNull();
});
