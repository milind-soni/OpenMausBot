// @vitest-environment happy-dom
import { createElement } from "react";
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
    const avatar = host.querySelector<HTMLElement>("[data-object-body='obj-mug']")!;
    await vi.waitFor(() => expect(avatar.querySelector("svg")).not.toBeNull());
    expect(avatar.getAttribute("role")).toBe("img");
    expect(avatar.getAttribute("aria-label")).toBe("Mugsy");
    expect(avatar.style.width).toBe("64px");
    flushSync(() => root.unmount());
    expect(avatar.childElementCount).toBe(0);
  });
});
