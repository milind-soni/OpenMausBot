// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {} }, dispatch: vi.fn() }) };
});

const { MemoryPage } = await import("./pages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bot = { id: "scout", threadId: "t1", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "x", model: "x" } } as unknown as Bot;
const files: Record<string, string> = {};
const puts: Array<{ text: string; expectedHash?: string }> = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hash = (text: string) => `h${text.length}:${text.split("\n").length}`;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  puts.length = 0;
  files["MEMORY.md"] = "# Memory\n\n- Prefers short replies.\n";
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { path: string; text: string; expectedHash?: string };
      puts.push({ text: body.text, expectedHash: body.expectedHash });
      const current = files[body.path];
      if (body.expectedHash !== hash(current)) return reply(409, { error: "conflict", current, currentHash: hash(current) });
      files[body.path] = body.text;
      return reply(200, { path: body.path, text: body.text, hash: hash(body.text), exists: true, overview: {} });
    }
    const path = url.searchParams.get("path") ?? "MEMORY.md";
    return reply(200, { path, text: files[path], hash: hash(files[path]), exists: true });
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
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const textarea = () => host.querySelector<HTMLTextAreaElement>("[data-memory-text]");
const type = (text: string) => act(() => {
  const field = textarea()!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
const open = async () => {
  await act(async () => root.render(createElement(MemoryPage, { bot, derived: {} as never })));
  await settle();
  await click(host.querySelector('[data-panel-link="memory-text"]'));
};

it("opens the whole MEMORY.md as text from What it remembers and saves it against the hash it was opened at", async () => {
  await open();
  expect(textarea()?.value).toBe("# Memory\n\n- Prefers short replies.\n");
  await type("# Memory\n\n- Prefers short replies in plain words.\n- Standup is at 10:30.\n");
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  expect(puts).toEqual([{ text: "# Memory\n\n- Prefers short replies in plain words.\n- Standup is at 10:30.\n", expectedHash: hash("# Memory\n\n- Prefers short replies.\n") }]);
  expect(files["MEMORY.md"]).toContain("Standup is at 10:30.");
  expect(textarea()).toBeNull();
  expect(host.textContent).toContain("Standup is at 10:30.");
});

it("never overwrites a note the bot wrote while the text was open: the person reloads or overwrites", async () => {
  await open();
  await type("# Memory\n\n- Mine.\n");
  files["MEMORY.md"] += "- The bot's note.\n";
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  expect(files["MEMORY.md"]).toContain("The bot's note.");
  expect(host.textContent).toContain("Scout changed this file while you were editing.");

  await click(button("Reload"));
  expect(textarea()?.value).toContain("The bot's note.");
  expect(host.querySelector("[data-memory-draft] pre")?.textContent).toBe("# Memory\n\n- Mine.\n");
  await type(`${textarea()!.value}- Mine.\n`);
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  expect(files["MEMORY.md"]).toBe("# Memory\n\n- Prefers short replies.\n- The bot's note.\n- Mine.\n");
  expect(textarea()).toBeNull();
});

it("can overwrite the bot's version on purpose", async () => {
  await open();
  await type("# Memory\n\n- Only this.\n");
  files["MEMORY.md"] += "- The bot's note.\n";
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  await click(button("Overwrite with mine"));
  expect(files["MEMORY.md"]).toBe("# Memory\n\n- Only this.\n");
  expect(textarea()).toBeNull();
});

it("Cancel leaves the file alone", async () => {
  await open();
  await type("# Memory\n");
  await click(button("Cancel"));
  expect(puts).toEqual([]);
  expect(textarea()).toBeNull();
  expect(host.textContent).toContain("Prefers short replies.");
});

it("closes the text when the person moves to another bot, so coming back shows the notes again", async () => {
  await open();
  const other = { ...bot, id: "atlas", name: "Atlas" } as Bot;
  await act(async () => root.render(createElement(MemoryPage, { bot: other, derived: {} as never })));
  await settle();
  expect(textarea()).toBeNull();
  await act(async () => root.render(createElement(MemoryPage, { bot, derived: {} as never })));
  await settle();
  expect(textarea()).toBeNull();
  expect(host.querySelector('[data-panel-link="memory-text"]')).toBeTruthy();
});

it("keeps every earlier draft when Reload is needed twice", async () => {
  await open();
  await type("# Memory\n\n- First draft.\n");
  files["MEMORY.md"] += "- The bot's note.\n";
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  await click(button("Reload"));
  await type("# Memory\n\n- Second draft.\n");
  files["MEMORY.md"] += "- Another bot note.\n";
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  await click(button("Reload"));
  const kept = host.querySelector("[data-memory-draft] pre")?.textContent;
  expect(kept).toContain("First draft.");
  expect(kept).toContain("Second draft.");
});

it("locks the text while it saves, so nothing typed after Save is lost", async () => {
  await open();
  let finish!: () => void;
  const fetchMock = vi.mocked(fetch);
  const real = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementationOnce((input, init) => new Promise((resolve) => { finish = () => resolve(real(input as string, init)); }));
  await type("# Memory\n\n- Saved.\n");
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  expect(textarea()?.readOnly).toBe(true);
  await act(async () => finish());
  await settle();
  expect(textarea()).toBeNull();
});

it("a save that finishes after moving to another bot does not show in that bot's notes", async () => {
  await open();
  let finish!: () => void;
  const fetchMock = vi.mocked(fetch);
  const real = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementationOnce((input, init) => new Promise((resolve) => { finish = () => resolve(real(input as string, init)); }));
  await type("# Memory\n\n- Late note.\n");
  await click(host.querySelector('[data-panel-done="memory-text"]'));
  const other = { ...bot, id: "atlas", name: "Atlas" } as Bot;
  await act(async () => root.render(createElement(MemoryPage, { bot: other, derived: {} as never })));
  await settle();
  await act(async () => finish());
  await settle();
  expect(files["MEMORY.md"]).toContain("Late note.");
  expect(host.textContent).toContain("Prefers short replies.");
  expect(host.textContent).not.toContain("Late note.");
});
