// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listing = [{ name: "notes", command: "npx", args: [], envKeys: [], enabled: true }];
const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({
  api,
  useStore: () => ({ state: { config: null }, dispatch: vi.fn() }),
}));
import { publishLiveFrame } from "@/lib/live-events";
import { McpServersPanel } from "./McpServersPanel";

let root: Root;
let host: HTMLElement;
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((candidate) => label.test(candidate.getAttribute("aria-label") ?? ""))!;
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.mockReset();
  api.mockImplementation(async () => ({ servers: listing }));
  vi.stubGlobal("confirm", () => true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(McpServersPanel)); });
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lists the servers again, without disabling anything, when one is added, changed or removed elsewhere", async () => {
  expect(api).toHaveBeenCalledTimes(1);
  publishLiveFrame({ kind: "sections", sections: [] });
  expect(api).toHaveBeenCalledTimes(1);
  let answer!: (value: unknown) => void;
  api.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  publishLiveFrame({ kind: "mcp.changed" });
  expect(api).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenLastCalledWith("/api/mcp/servers");
  await flush();
  expect(button(/edit.*notes/i).disabled).toBe(false);
  await act(async () => { answer({ servers: [{ ...listing[0], name: "docs" }] }); });
  expect(host.textContent).toContain("docs");
  expect(button(/edit.*docs/i).disabled).toBe(false);
});

it("leaves a panel's own step alone when a change arrives in the middle of it", async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { button(/remove.*notes/i).click(); });
  expect(api).toHaveBeenCalledTimes(2);
  expect(button(/edit.*notes/i).disabled).toBe(true);
  publishLiveFrame({ kind: "mcp.changed" });
  await flush();
  expect(api).toHaveBeenCalledTimes(2);
  expect(button(/edit.*notes/i).disabled).toBe(true);
  await act(async () => { finish({ servers: [] }); });
  expect(host.textContent).not.toContain("notes");
});
