// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
const inbox = vi.hoisted(() => ({ open: false }));
vi.mock("@/state/store", () => ({ useStore: () => store, currentTaskBot: (bot: object) => bot }));
vi.mock("@/lib/default-bot", () => ({ useViewerEmail: () => null }));
vi.mock("@/state/inbox", async (importOriginal) => ({ ...await importOriginal<object>(), useInboxPanel: () => ({ open: inbox.open }) }));
vi.mock("./room-feed/use-room-feed", async (importOriginal) => ({ ...await importOriginal<object>(), useRoomFeedHere: () => true }));
vi.mock("./ChatView", () => ({ ChatView: () => null }));
vi.mock("./GroupView", () => ({ GroupView: () => null }));

import { ForkPanel } from "./ForkPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

const render = () => act(() => root.render(createElement(ForkPanel)));
const panelWidth = () => container.querySelector("aside")!.style.width;
const widen = () => act(() => {
  container.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
});

beforeEach(() => {
  localStorage.clear();
  inbox.open = false;
  store.state = {
    forkPanel: { kind: "bot", ownerId: "bot", threadId: "thread", messages: [], loadId: "load" },
    bots: [{ id: "bot", name: "Bot", tasks: [{ threadId: "thread", title: "Thread" }] }],
    groups: [],
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

it("widens beside the Inbox when the edge is dragged, and keeps that width for the next time the Inbox is open", () => {
  inbox.open = true;
  render();
  expect(panelWidth()).toBe("400px");
  widen();
  widen();
  expect(panelWidth()).toBe("480px");
  inbox.open = false;
  render();
  expect(panelWidth()).toBe("440px");
  inbox.open = true;
  render();
  expect(panelWidth()).toBe("480px");
});

it("starts beside the Inbox at the narrower width already chosen without it", () => {
  localStorage.setItem("omb-thread-panel-width", "360");
  inbox.open = true;
  render();
  expect(panelWidth()).toBe("360px");
  localStorage.setItem("omb-thread-panel-width", "700");
  act(() => root.unmount());
  root = createRoot(container);
  render();
  expect(panelWidth()).toBe("400px");
});
