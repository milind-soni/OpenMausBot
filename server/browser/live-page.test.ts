import { describe, expect, it } from "vitest";

import { activeTargetOf, keyEvent, pressedAtOnce } from "./live-page.ts";

describe("a view's key as Chrome's key event", () => {
  it("fills a letter's or digit's code from its key when the view sent none, and types only on a key-down", () => {
    expect(keyEvent("keyDown", { key: "q", code: "KeyQ", text: "q" })).toMatchObject({ type: "keyDown", windowsVirtualKeyCode: 81, text: "q", unmodifiedText: "q" });
    expect(keyEvent("keyUp", { key: "7", code: "Digit7", text: "7" })).toEqual({ type: "keyUp", key: "7", code: "Digit7", windowsVirtualKeyCode: 55, modifiers: 0 });
  });
  it("gives named keys sent without a code their code, and Enter its line break unless a shortcut holds it", () => {
    expect(keyEvent("keyDown", { key: "Enter", code: "Enter" })).toEqual({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
    expect(keyEvent("keyDown", { key: "Enter", code: "Enter", modifiers: 2 })).toEqual({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
    expect(keyEvent("keyDown", { key: "Backspace", code: "Backspace" })).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 8 });
    expect(keyEvent("keyDown", { key: "F7", code: "F7" })).toMatchObject({ windowsVirtualKeyCode: 0 });
  });
  it("places right-hand modifiers and the number pad", () => {
    expect(keyEvent("keyDown", { key: "Control", code: "ControlRight", windowsVirtualKeyCode: 17, modifiers: 2 })).toMatchObject({ type: "rawKeyDown", location: 2 });
    expect(keyEvent("keyDown", { key: "1", code: "Numpad1", windowsVirtualKeyCode: 97, text: "1" })).toMatchObject({ location: 3, windowsVirtualKeyCode: 97 });
    expect(keyEvent("keyDown", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 })).not.toHaveProperty("location");
  });
  it("presses shortcuts and named keys at once, and holds plain and shifted characters and modifiers", () => {
    expect([{ key: "a", modifiers: 4 }, { key: "Tab" }, { key: "Tab", modifiers: 8 }].every(pressedAtOnce)).toBe(true);
    expect([{ key: "a" }, { key: "A", modifiers: 8 }, { key: "Shift", modifiers: 8 }, { key: "F2" }].some(pressedAtOnce)).toBe(false);
  });
});

describe("the stream's active tab", () => {
  it("is read from a tab list only, and only a well-formed target", () => {
    expect(activeTargetOf({ type: "url", url: "https://example.com/" })).toBeUndefined();
    expect(activeTargetOf({ type: "tabs", tabs: [{ tabId: "t1", targetId: "A1", active: false }, { tabId: "t2", targetId: "B2", active: true }] })).toBe("B2");
    expect(activeTargetOf({ type: "tabs", tabs: [{ tabId: "t1", targetId: "../x", active: true }] })).toBeNull();
    expect(activeTargetOf({ type: "tabs", tabs: [] })).toBeNull();
  });
});
