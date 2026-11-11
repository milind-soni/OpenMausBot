// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ team: true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.team ? { team: { id: "t", name: "Acme" } } : {} }, dispatch: vi.fn() }) };
});

const { MemoryPage } = await import("./pages");
const { LibraryTab } = await import("./LibraryTab");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bot = { id: "scout", threadId: "t1", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "x", model: "x" } } as unknown as Bot;
const files: Record<string, string> = {};
const calls: Array<[string, string]> = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.team = true;
  calls.length = 0;
  Object.assign(files, { "MEMORY.md": "# Memory\n", "memory/food.md": "- Ada's favourite fruit is durian\n" });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    const method = init?.method ?? "GET";
    calls.push([method, url.pathname]);
    if (!url.pathname.includes("/memory/mine")) return reply(403, { error: "forbidden: this session lacks the admin scope" });
    const path = url.searchParams.get("path") ?? (init?.body ? JSON.parse(String(init.body)).path : "MEMORY.md");
    if (url.pathname.endsWith("/mine")) return reply(200, { topics: Object.keys(files).filter((file) => file.startsWith("memory/")).map((file) => ({ path: file })) });
    if (method === "PUT") files[path] = JSON.parse(String(init!.body)).text;
    if (method === "DELETE") delete files[path];
    const text = files[path] ?? "";
    return reply(200, { path, text, hash: `h${text.length}`, exists: path in files, overview: {} });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

it("on a Team Cloud shows what the bot remembers about the person, from their own notes, and lets them forget it", async () => {
  await act(async () => root.render(createElement(MemoryPage, { bot, derived: {} as never })));
  await settle();
  expect(host.textContent).toContain("Ada's favourite fruit is durian");
  expect(host.textContent).not.toContain("Couldn't read the memory file");
  expect(calls.every(([, path]) => path.includes("/memory/mine"))).toBe(true);
  const forget = host.querySelector<HTMLButtonElement>("[data-memory-note] button")!;
  await act(async () => forget.click());
  await settle();
  expect(files["memory/food.md"]).toBe("");
  expect(host.textContent).not.toContain("durian");
});

it("counts those notes on the Library tab", async () => {
  await act(async () => root.render(createElement(LibraryTab, { bot, onOpen: () => {} })));
  await settle();
  expect(host.querySelector('[data-panel-page="memory"]')?.textContent).toContain("1 note");
});
