// @vitest-environment happy-dom
// The Inbox's active list marks an unread conversation with a dot.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttentionThreadRows, type AttentionThread } from "./SidebarBotActivity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const entry = (threadId: string, unread: boolean): AttentionThread => ({
  kind: "bot", botId: "eli", botName: "Eli",
  task: { threadId, title: threadId, createdAt: 1, updatedAt: 1, queued: false, ...(unread ? { unread: true } : {}) },
});
const mount = (unreadDot: boolean) => act(async () => {
  root.render(createElement(AttentionThreadRows, {
    entries: [entry("unread-thread", true), entry("read-thread", false)],
    inset: true, unreadDot, onJump: () => undefined,
  }));
});

beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement("div"))); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

describe("the unread dot on the active list", () => {
  it("marks only the unread conversation", async () => {
    await mount(true);
    const dots = [...document.querySelectorAll("[data-attention-unread-dot]")];
    expect(dots).toHaveLength(1);
    expect(dots[0]!.closest("button")!.textContent).toContain("unread-thread");
  });

  it("draws nothing extra with the switch off", async () => {
    await mount(false);
    expect(document.querySelectorAll("[data-attention-unread-dot]")).toHaveLength(0);
  });
});
