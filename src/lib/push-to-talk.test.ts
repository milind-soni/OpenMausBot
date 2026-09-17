import { describe, expect, it } from "vitest";

import { isTalkKey, isTypingTarget } from "./push-to-talk";

/** Only the fields the predicate reads. */
const key = (over: Partial<Parameters<typeof isTalkKey>[0]> = {}) => ({
  code: "Space",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...over,
});

describe("isTalkKey", () => {
  it("is the bare space bar", () => {
    expect(isTalkKey(key())).toBe(true);
  });

  it("yields every space-bar combination someone else owns", () => {
    // Shift+Space, Ctrl+Space (hold-to-dictate) and Cmd+Space are other
    // gestures; the talk key is the unmodified one.
    expect(isTalkKey(key({ shiftKey: true }))).toBe(false);
    expect(isTalkKey(key({ ctrlKey: true }))).toBe(false);
    expect(isTalkKey(key({ metaKey: true }))).toBe(false);
    expect(isTalkKey(key({ altKey: true }))).toBe(false);
  });

  it("ignores auto-repeat — a held key is one press, not fifty", () => {
    expect(isTalkKey(key({ repeat: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isTalkKey(key({ code: "Enter" }))).toBe(false);
    expect(isTalkKey(key({ code: "KeyK" }))).toBe(false);
    expect(isTalkKey(key({ code: "Spacebar" }))).toBe(false);
  });
});

describe("isTypingTarget", () => {
  const target = (tagName: string, contentEditable = false) =>
    ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget;

  it("leaves the space bar to anything the user types into", () => {
    expect(isTypingTarget(target("INPUT"))).toBe(true);
    expect(isTypingTarget(target("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(target("SELECT"))).toBe(true);
    // a rich-text composer is an editor without being a form field
    expect(isTypingTarget(target("DIV", true))).toBe(true);
  });

  it("treats the call surface itself as talkable", () => {
    expect(isTypingTarget(target("DIV"))).toBe(false);
    expect(isTypingTarget(target("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("survives a target with no tagName at all", () => {
    expect(isTypingTarget({} as EventTarget)).toBe(false);
    expect(isTypingTarget("not-a-node" as unknown as EventTarget)).toBe(false);
  });
});
