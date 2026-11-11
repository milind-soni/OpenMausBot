// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNREAD_NOTICE_MS, useUnreadNotice } from "./unread-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let noticing: boolean | undefined;
function Row({ unread }: { unread: boolean }) {
  noticing = useUnreadNotice(unread);
  return null;
}

let host: HTMLDivElement;
let root: Root;
const show = (unread: boolean) => act(() => root.render(createElement(Row, { unread })));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("an unread bot's notice", () => {
  it("plays when news arrives, then holds still while the bot stays unread", () => {
    show(false);
    expect(noticing).toBe(false);
    show(true);
    expect(noticing).toBe(true);
    wait(UNREAD_NOTICE_MS - 1);
    expect(noticing).toBe(true);
    wait(1);
    expect(noticing).toBe(false);
    show(true);
    wait(60_000);
    expect(noticing).toBe(false);
  });

  it("holds still for a bot that was already unread when its row appeared", () => {
    show(true);
    expect(noticing).toBe(false);
    wait(UNREAD_NOTICE_MS);
    expect(noticing).toBe(false);
  });

  it("stops when the bot is read and plays again for the next news", () => {
    show(false);
    show(true);
    wait(1_000);
    show(false);
    expect(noticing).toBe(false);
    show(true);
    expect(noticing).toBe(true);
    wait(UNREAD_NOTICE_MS);
    expect(noticing).toBe(false);
  });
});
