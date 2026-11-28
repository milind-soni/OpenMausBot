// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => store, currentTaskBot: (bot: object) => bot }));
vi.mock("@/lib/default-bot", () => ({ useViewerEmail: () => null }));
vi.mock("./ChatView", () => ({ ChatView: () => createElement("div", { "data-tour": "composer" }, createElement("textarea")) }));
vi.mock("./GroupView", () => ({ GroupView: () => createElement("div", { "data-tour": "composer" }, createElement("textarea")) }));

import { ForkPanel } from "./ForkPanel";

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
