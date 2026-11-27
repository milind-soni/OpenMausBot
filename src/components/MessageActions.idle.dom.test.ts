// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatBusyContext, MessageActions, type MessageMenuItem } from "./MessageActions";

const items: MessageMenuItem[] = [
  { key: "edit", icon: null, label: "Edit", onSelect() {}, idleOnly: true },
  { key: "id", icon: null, label: "Copy id", onSelect() {} },
];

describe("a chat message's menu while a turn runs", () => {
  let root: Root, host: HTMLElement;
  const draw = (busy: boolean) => flushSync(() => root.render(createElement(ChatBusyContext, { value: busy }, createElement(MessageActions, { side: "user", menu: items }))));
  const offered = () => [...host.querySelectorAll("[role=menuitem]")].map((item) => item.textContent);
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  it("leaves out what only works between turns, and offers it again when the turn ends", () => {
    draw(true);
    flushSync(() => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!.click());
    expect(offered()).toEqual(["Copy id"]);
    draw(false);
    expect(offered()).toEqual(["Edit", "Copy id"]);
    draw(true);
    expect(offered()).toEqual(["Copy id"]);
  });
});
