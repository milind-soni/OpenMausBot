// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: fixture.api,
    useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }),
  };
});

import { QuickComposer } from "./RoutineCalendarPage";

const bot: Bot = {
  id: "ime-bot", threadId: "ime-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "",
  modelSelection: { instanceId: "claude", model: "fake" },
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ call: { id: "call-1", name: "周报 huiyi" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function open() {
  const onClose = vi.fn();
  const onSavedCall = vi.fn();
  flushSync(() => root.render(createElement(QuickComposer, {
    seed: { kind: "call", at: Date.now() + 3_600_000, durationMinutes: 30, botIds: [bot.id] },
    bots: [bot],
    onClose,
    onMore: vi.fn(),
    onSavedRoutine: vi.fn(),
    onSavedCall,
  })));
  const input = host.querySelector<HTMLInputElement>('input[aria-label]')!;
  return { input, onClose, onSavedCall };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(input: HTMLInputElement, init: KeyboardEventInit = {}) {
  return flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })));
}

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

describe("calendar quick composer with an input method", () => {
  it.each(IME)("does not create the event on the Enter that belongs to the $name", async ({ init }) => {
    const { input, onClose, onSavedCall } = open();
    type(input, "周报 huiyi");
    press(input, init);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(onSavedCall).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("周报 huiyi");
    expect(host.querySelector("input")).toBe(input);
  });

  it("still creates the event on a plain Enter", async () => {
    const { input, onClose, onSavedCall } = open();
    type(input, "Weekly review");
    press(input);
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledOnce());
    expect(fixture.api).toHaveBeenCalledWith("/api/calendar-calls", expect.objectContaining({ method: "POST" }));
    await vi.waitFor(() => expect(onSavedCall).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
