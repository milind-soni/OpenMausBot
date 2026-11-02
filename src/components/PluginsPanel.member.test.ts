// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const refused = Object.assign(new Error("forbidden: this session lacks the admin scope"), { status: 403 });
vi.mock("@/state/store", () => ({
  api: vi.fn(() => Promise.reject(refused)),
  useStore: () => ({ state: { pluginsSurface: "apps", bots: [], instances: [] }, dispatch: vi.fn() }),
}));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => null }));
vi.mock("./HighLevelCard", () => ({ HighLevelCard: () => null }));
vi.mock("./XCard", () => ({ X_CARD_SEARCH: "x", XCard: () => null }));

const { PluginsPanel } = await import("./PluginsPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("tells a session without the admin scope why, and stops loading, instead of blaming this Mac's credential store", async () => {
  await act(async () => root.render(createElement(PluginsPanel)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const text = host.textContent ?? "";
  expect(text).toContain("Only an admin of this installation can connect apps here.");
  expect(text).not.toContain("credential store");
  expect(text).not.toContain("Loading catalog");
  expect(text).not.toContain("lacks the admin scope");
});
