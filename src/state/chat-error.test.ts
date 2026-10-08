// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ERROR_CLEAR_MS, useChatErrorClear } from "./chat-error";

function Harness({ error, clear }: { error: string | null; clear: () => void }) {
  useChatErrorClear(error, clear);
  return null;
}

describe("useChatErrorClear", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears a chat error once, after the shared delay", () => {
    const clear = vi.fn();
    act(() => { root.render(createElement(Harness, { error: "no images", clear })); });
    act(() => { vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS - 1); });
    expect(clear).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("restarts the delay when a new error replaces the current one", () => {
    const clear = vi.fn();
    act(() => { root.render(createElement(Harness, { error: "first", clear })); });
    act(() => { vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS - 1); });
    act(() => { root.render(createElement(Harness, { error: "second", clear })); });
    act(() => { vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS - 1); });
    expect(clear).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does not clear after the error is already gone", () => {
    const clear = vi.fn();
    act(() => { root.render(createElement(Harness, { error: "first", clear })); });
    act(() => { root.render(createElement(Harness, { error: null, clear })); });
    act(() => { vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS); });
    expect(clear).not.toHaveBeenCalled();
  });

  it("stays quiet when there is no error", () => {
    const clear = vi.fn();
    act(() => { root.render(createElement(Harness, { error: null, clear })); });
    act(() => { vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS); });
    expect(clear).not.toHaveBeenCalled();
  });
});
