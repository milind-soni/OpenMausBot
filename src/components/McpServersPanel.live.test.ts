// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn(async () => ({ servers: [] })));
vi.mock("@/state/store", () => ({
  api,
  useStore: () => ({ state: { config: null }, dispatch: vi.fn() }),
}));
import { publishLiveFrame } from "@/lib/live-events";
import { McpServersPanel } from "./McpServersPanel";

it("lists the servers again when one is added, changed or removed elsewhere", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(McpServersPanel)));
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  publishLiveFrame({ kind: "sections", sections: [] });
  publishLiveFrame({ kind: "mcp.changed" });
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api).toHaveBeenLastCalledWith("/api/mcp/servers");
  root.unmount();
});
