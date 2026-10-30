// @vitest-environment happy-dom
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestChatFind, useChatFindOpen, useChatFindRequests } from "./chat-find";

let root: Root;
let container: HTMLDivElement;
const seen: Record<string, boolean> = {};

function Chat({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  useChatFindRequests(threadId, open, setOpen);
  return createElement("span", { "data-find": open ? "open" : "closed" });
}
function Menu({ threadId }: { threadId: string }) {
  seen[threadId] = useChatFindOpen(threadId);
  return null;
}
const bar = () => container.querySelector("[data-find]")?.getAttribute("data-find");
const render = (threadId: string) => flushSync(() => root.render([
  createElement(Chat, { key: "chat", threadId }),
  createElement(Menu, { key: "menu", threadId }),
  createElement(Menu, { key: "other", threadId: "elsewhere" }),
]));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("the chat find bar, opened from a menu outside the chat", () => {
  it("toggles the bar of the chat on that thread and tells menus it is open", () => {
    render("t1");
    expect(bar()).toBe("closed");
    flushSync(() => requestChatFind("t1"));
    expect(bar()).toBe("open");
    expect(seen).toMatchObject({ t1: true, elsewhere: false });
    flushSync(() => requestChatFind("t1"));
    expect(bar()).toBe("closed");
    expect(seen.t1).toBe(false);
  });

  it("ignores a request for another thread", () => {
    render("t1");
    flushSync(() => requestChatFind("t2"));
    expect(bar()).toBe("closed");
  });

  it("follows the chat to its new thread, and forgets the bar once the chat is gone", () => {
    render("t1");
    render("t2");
    flushSync(() => requestChatFind("t2"));
    expect(bar()).toBe("open");
    expect(seen.t2).toBe(true);
    flushSync(() => root.render(createElement(Menu, { threadId: "t2" })));
    expect(seen.t2).toBe(false);
  });
});
