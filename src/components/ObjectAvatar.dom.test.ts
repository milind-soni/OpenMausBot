// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { MAUS_STATES, type MausState } from "@/lib/mascot";
import { MausAvatar } from "./Avatar";
import { objectLook } from "./ObjectAvatar";

describe("objectLook", () => {
  it.each<[MausState, ReturnType<typeof objectLook>]>([
    ["idle", { state: "idle", mood: "neutral" }],
    ["thinking", { state: "thinking", mood: "neutral" }],
    ["writing", { state: "working", mood: "neutral" }],
    ["searching", { state: "working", mood: "neutral" }],
    ["alerting", { state: "waiting", mood: "neutral" }],
    ["sad", { state: "blocked", mood: "neutral" }],
    ["celebrate", { state: "done", mood: "neutral" }],
    ["laughing", { state: "idle", mood: "happy" }],
    ["sleeping", { state: "idle", mood: "neutral" }],
  ])("shows %s as %o", (state, expected) => {
    expect(objectLook(state)).toEqual(expected);
  });

  it("gives every mascot state a look", () => {
    for (const state of MAUS_STATES) expect(objectLook(state).state).toBeTypeOf("string");
  });
});

describe("an object body", () => {
  it("draws the avatar in the bot's colour, labelled, and clears it when unmounted", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(MausAvatar, { bodyId: "obj-mug", color: "blue", animated: false, label: "Mugsy", size: 64 })));
    const avatar = host.querySelector<HTMLElement>("[data-object-body='mug']")!;
    await vi.waitFor(() => expect(avatar.querySelector("svg")).not.toBeNull());
    expect(avatar.getAttribute("role")).toBe("img");
    expect(avatar.getAttribute("aria-label")).toBe("Mugsy");
    expect(avatar.style.width).toBe("64px");
    flushSync(() => root.unmount());
    expect(avatar.childElementCount).toBe(0);
  });

  it("paints a shape in the bot's custom colour", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(MausAvatar, { bodyId: "circle", color: "blue", bodyColor: "#123456", animated: false, size: 64 })));
    const avatar = host.querySelector<HTMLElement>("[data-object-body='circle']")!;
    await vi.waitFor(() => expect(avatar.innerHTML).toContain('fill="#123456"'));
    flushSync(() => root.unmount());
  });

  it("celebrates once with the ribbon cage when it finishes working, then rests", () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const show = (state: MausState) => act(() => root.render(createElement(MausAvatar, { bodyId: "obj-mug", color: "blue", state, size: 64 })));
      const shown = () => host.querySelector<HTMLElement>("[data-object-body]")!.dataset.objectState;
      show("idle");
      expect(shown()).toBe("idle");
      show("working");
      expect(shown()).toBe("working");
      show("idle");
      expect(shown()).toBe("done");
      act(() => vi.advanceTimersByTime(5000));
      expect(shown()).toBe("idle");
      show("sleeping");
      expect(shown()).toBe("idle");
      act(() => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});
