// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, type Bot } from "@/state/store";

const network = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: network }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));

const { BotThreadList, botRowProps } = await import("./Sidebar");
const { BotConversations, forgetConversationLines, showAllConversations } = await import("./bot-panel/Conversations");
let report: (entries: { target: Element; isIntersecting: boolean }[]) => void;
class Observer {
  constructor(callback: typeof report) { report = callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const bot: Bot = {
  id: "preview-bot", threadId: "open", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "test" },
  messages: [{ id: "open-message", role: "bot", kind: "text", text: "Open conversation", at: 10 }],
  projects: [{ id: "folder", name: "Folder" }],
  tasks: [
    { threadId: "open", title: "New thread", createdAt: 10 },
    { threadId: "first", title: "New thread", createdAt: 9 },
    { threadId: "second", title: "New thread", createdAt: 8 },
    { threadId: "folded", title: "Folded", createdAt: 7, projectId: "folder" },
  ],
};
let host: HTMLDivElement;
let root: Root;
const render = async (hidden = false) => act(async () => root.render(createElement(BotThreadList, {
  ...botRowProps(initialState, vi.fn(), bot, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true, hidden,
})));
const row = (id: string) => host.querySelector(`[data-sidebar-thread-row="${id}"]`)!;
const visible = async (id: string) => act(async () => {
  report([{ target: row(id).parentElement!.parentElement!, isIntersecting: true }]);
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", Observer);
  localStorage.clear();
  forgetConversationLines();
  network.mockReset();
  network.mockImplementation(async (path: string) => ({ messages: [{ id: path, role: "bot", kind: "text", text: path.includes("first") ? "First answer" : "Second answer", at: 10 }] }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("distinguishes identical titles with their visible conversation lines", async () => {
  await render();
  expect(network).not.toHaveBeenCalled();
  await visible("open");
  await visible("first");
  await visible("second");
  expect(row("open").textContent).toContain("Open conversation");
  expect(row("first").textContent).toContain("First answer");
  expect(row("second").textContent).toContain("Second answer");
  expect(row("first").textContent).not.toContain("Untitled chat");
  expect(row("second").textContent).not.toContain("Untitled chat");
  expect(row("first").querySelector('[title="First answer"]')?.className).toContain("truncate");
  expect(network.mock.calls.map(([path]) => path).sort()).toEqual(["/api/threads/first/messages?limit=8", "/api/threads/second/messages?limit=8"]);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Collapse Folder threads"]')!.click());
  expect(host.querySelector('[data-sidebar-thread-row="folded"]')).toBeNull();
  await render(true);
  expect(network).toHaveBeenCalledTimes(2);
});

it("limits concurrent requests and drops queued rows when hidden", async () => {
  const resolve: Array<(value: unknown) => void> = [];
  network.mockImplementation(() => new Promise((done) => { resolve.push(done); }));
  const many = { ...bot, threadId: "open", tasks: [{ threadId: "open", title: "New thread", createdAt: 20 }, ...Array.from({ length: 5 }, (_, i) => ({ threadId: `queued-${i}`, title: "New thread", createdAt: 19 - i }))] };
  await act(async () => root.render(createElement(BotThreadList, { ...botRowProps(initialState, vi.fn(), many, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true })));
  for (let i = 0; i < 5; i++) await visible(`queued-${i}`);
  expect(network).toHaveBeenCalledTimes(4);
  await render(true);
  await act(async () => { for (const done of resolve) done({ messages: [] }); });
  expect(network).toHaveBeenCalledTimes(4);
});

it("lets the panel load all conversations immediately and share sidebar requests", async () => {
  const pending: Array<(page: unknown) => void> = [];
  network.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  const many: Bot = { ...bot, tasks: [{ threadId: "open", title: "New thread", createdAt: 20 }, ...Array.from({ length: 7 }, (_, i) => ({ threadId: `shared-${i}`, title: `Thread ${i}`, createdAt: 19 - i }))] };
  const tree = (panel: boolean, hidden = false) => createElement(StoreProvider, null,
    createElement(BotThreadList, { ...botRowProps(initialState, vi.fn(), many, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true, hidden }),
    panel ? createElement(BotConversations, { bot: many }) : null,
  );
  await act(async () => root.render(tree(false)));
  for (let i = 0; i < 5; i++) await visible(`shared-${i}`);
  expect(network).toHaveBeenCalledTimes(4);
  showAllConversations(many.id);
  await act(async () => root.render(tree(true)));
  const paths = network.mock.calls.map(([path]) => path as string);
  expect(paths).toHaveLength(7);
  expect(new Set(paths).size).toBe(7);
  const sharedSignal = network.mock.calls.find(([path]) => path.includes("shared-0"))![1].signal as AbortSignal;
  await act(async () => root.render(tree(true, true)));
  expect(sharedSignal.aborted).toBe(false);
  await act(async () => { for (const resolve of pending) resolve({ messages: [{ id: "answer", role: "bot", kind: "text", text: "Panel answer", at: 10 }] }); });
  expect(host.querySelector('[data-conversation="shared-0"]')?.textContent).toContain("Panel answer");
});

it("cancels hidden sidebar requests and retries only after a row becomes visible again", async () => {
  const pending: Array<(page: unknown) => void> = [];
  network.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  await render();
  await visible("first");
  const signal = network.mock.calls[0]![1].signal as AbortSignal;
  await render(true);
  expect(signal.aborted).toBe(true);
  await act(async () => pending[0]!({ messages: [{ id: "old", role: "bot", kind: "text", text: "Old answer", at: 10 }] }));
  await render();
  await visible("first");
  expect(network).toHaveBeenCalledTimes(2);
  await act(async () => pending[1]!({ messages: [{ id: "new", role: "bot", kind: "text", text: "New answer", at: 10 }] }));
  expect(row("first").textContent).toContain("New answer");
  expect(row("first").textContent).not.toContain("Old answer");
});

it("waits for a cancelled request to settle before re-requesting a visible row", async () => {
  const pending: Array<(page: unknown) => void> = [];
  network.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  await render();
  await visible("first");
  await render(true);
  await render();
  await visible("first");
  expect(network).toHaveBeenCalledTimes(1);
  await act(async () => pending[0]!({ messages: [] }));
  expect(network).toHaveBeenCalledTimes(2);
  await act(async () => pending[1]!({ messages: [{ id: "new", role: "bot", kind: "text", text: "New answer", at: 10 }] }));
  expect(row("first").textContent).toContain("New answer");
});

it("does not repopulate a cleared preview cache from a late response", async () => {
  const pending: Array<(page: unknown) => void> = [];
  network.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  await render();
  await visible("first");
  await render(true);
  forgetConversationLines();
  await act(async () => pending[0]!({ messages: [{ id: "old", role: "bot", kind: "text", text: "Old answer", at: 10 }] }));
  await render();
  await visible("first");
  expect(network).toHaveBeenCalledTimes(2);
  await act(async () => pending[1]!({ messages: [] }));
});

it("does not retry a failed sidebar request on an unrelated rerender", async () => {
  network.mockRejectedValue(new Error("offline"));
  await render();
  await visible("first");
  await render();
  expect(network).toHaveBeenCalledTimes(1);
  await render(true);
  await render();
  await visible("first");
  expect(network).toHaveBeenCalledTimes(2);
});
