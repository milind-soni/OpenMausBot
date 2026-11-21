// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({
  api,
  useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }),
}));

import { McpServersPanel } from "./McpServersPanel";

const server = { name: "docs", type: "http", url: "https://mcp.example.test/mcp", headerKeys: ["Authorization"], enabled: true };

function Panel({ embedded }: { embedded: boolean }) {
  return McpServersPanel({ embedded });
}

let root: Root;
let host: HTMLElement;
let listed!: (value: unknown) => void;

// Chrome's page translation swaps each text node for <font><font>translation</font></font>.
function translatePage(node: Node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts.filter((candidate) => candidate.data.trim())) {
    const outer = document.createElement("font");
    const inner = document.createElement("font");
    inner.textContent = `翻译 ${text.data}`;
    outer.append(inner);
    text.replaceWith(outer);
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  api.mockReset();
  api.mockImplementation((path: string) => path === "/api/mcp/servers" ? new Promise((resolve) => { listed = resolve; }) : new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it.each([
  ["on its own", false],
  ["inside the Apps pop-up", true],
])("shows the server list after a translated page finishes loading it, %s", async (_where, embedded) => {
  await act(async () => { root.render(createElement(Panel, { embedded })); });
  expect(host.textContent).toContain("Loading MCP servers");
  translatePage(host);
  await act(async () => { listed({ servers: [server] }); });
  expect(host.textContent).not.toContain("Loading MCP servers");
  expect(host.querySelector('[aria-label="Edit docs"]')).not.toBeNull();
});
