// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ForkPanelState } from "@/state/fork-panel";
import type { Group } from "@/state/store";
import { expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => store, currentTaskBot: (bot: object) => bot }));
vi.mock("./ChatView", () => ({ ChatView: () => createElement("div", { "data-tour": "composer" }, createElement("textarea")) }));
vi.mock("./GroupView", () => ({ GroupView: ({ group, bare }: { group: Group; bare?: boolean }) => createElement("div",
  { "data-tour": "composer", "data-bare": bare, "data-turn-start": group.turnStartedAt }, createElement("textarea")) }));

import { ForkPanel, PanelChat } from "./ForkPanel";

it.each(["bot", "group"] as const)("moves focus from the source to a newly created %s fork", (kind) => {
  const input = document.createElement("textarea");
  const container = document.createElement("div");
  document.body.append(input, container);
  const root = createRoot(container);
  const panel = { kind, ownerId: kind, threadId: "fork", messages: [], loadId: "load", focusComposer: true };
  const owner = { id: kind, tasks: [{ threadId: "fork", title: "Fork" }] };
  store.state = { forkPanel: { ...panel, loading: true }, bots: kind === "bot" ? [owner] : [], groups: kind === "group" ? [owner] : [] };
  input.focus();
  try {
    flushSync(() => root.render(createElement(ForkPanel)));
    expect(document.activeElement).toBe(container.querySelector("aside"));
    store.state = { ...store.state, forkPanel: { ...panel, loading: false } };
    flushSync(() => root.render(createElement(ForkPanel)));
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  } finally {
    flushSync(() => root.unmount());
    input.remove();
    container.remove();
  }
});

it("keeps a tiled room's header and running turn, but uses the feed panel's header beside its feed", () => {
  const panel: ForkPanelState = { kind: "group", ownerId: "room", threadId: "current", messages: [],
    activeLeafId: null, loading: false, loadId: "load", loadFailed: false };
  // A current thread can be opened even before its room has a task list.
  const room = { id: "room", threadId: "current", name: "Room", working: true, turnStartedAt: 123 };
  store.state = { forkPanel: panel, config: { features: { roomFeed: true } }, groups: [room], bots: [] };
  const tiled = renderToStaticMarkup(createElement(PanelChat, { panel }));
  expect(tiled).toContain('data-bare="false"');
  expect(tiled).toContain('data-turn-start="123"');
  const feed = renderToStaticMarkup(createElement(ForkPanel, { full: true }));
  expect(feed).toContain("data-thread-back");
  expect(feed).toContain('data-bare="true"');
  expect(feed).toContain('data-turn-start="123"');
});
