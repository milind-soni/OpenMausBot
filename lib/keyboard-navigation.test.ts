import { describe, expect, it } from "vitest";
import { issueActionShortcut, shouldFocusChatComposer, workspaceShortcut } from "./keyboard-navigation";
import { issueShortcut } from "./project-issues";

const key = (value: string, extra: Partial<KeyboardEvent> = {}) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, defaultPrevented: false, repeat: false, ...extra });
const context = { editing: false, overlayOpen: false, canCreate: true };
const chat = { ...context, canWrite: true, controlHasFocus: false };

describe("workspace keyboard shortcuts", () => {
  it("opens creation with C and search with F or slash", () => {
    for (const c of ["c", "C"]) expect(workspaceShortcut(key(c), context)).toBe("create-issue");
    for (const c of ["f", "F", "/"]) expect(workspaceShortcut(key(c), context)).toBe("search");
    expect(workspaceShortcut(key("v"), context)).toBeNull();
  });
  it("does not intercept normal editor input or existing dialogs", () => {
    for (const c of ["c", "f", "/"]) {
      expect(workspaceShortcut(key(c), { ...context, editing: true })).toBeNull();
      expect(workspaceShortcut(key(c), { ...context, overlayOpen: true })).toBeNull();
    }
  });
  it("opens the command menu with Cmd/Ctrl+K but leaves browser shortcuts alone", () => {
    expect(workspaceShortcut(key("k", { metaKey: true }), { ...context, editing: true })).toBe("command-menu");
    expect(workspaceShortcut(key("k", { ctrlKey: true }), context)).toBe("command-menu");
    expect(workspaceShortcut(key("f", { metaKey: true }), context)).toBeNull();
    expect(workspaceShortcut(key("c", { ctrlKey: true }), context)).toBeNull();
    expect(workspaceShortcut(key("f", { altKey: true }), context)).toBeNull();
  });
  it("ignores compositions, held shortcuts, prevented events and read-only creation", () => {
    for (const extra of [{ isComposing: true }, { repeat: true }, { defaultPrevented: true }]) expect(workspaceShortcut(key("c", extra), context)).toBeNull();
    expect(workspaceShortcut(key("c"), { ...context, canCreate: false })).toBeNull();
  });
});

describe("shortcut reference and issue keys", () => {
  const issue = { editing: false, overlayOpen: false, hasIssue: true, canEdit: true };
  const k = (value: string, extra: Partial<KeyboardEvent> = {}) => ({ ...key(value, extra), shiftKey: false, ...extra });
  it("opens the shortcut list with ?", () => {
    expect(workspaceShortcut(key("?"), context)).toBe("shortcuts");
    expect(workspaceShortcut(key("?"), { ...context, editing: true })).toBeNull();
  });
  it("maps S, P, L, A, I and Shift+D to the focused issue", () => {
    expect(["s", "P", "l", "a", "i"].map(c => issueActionShortcut(k(c), issue))).toEqual(["status", "priority", "labels", "assignee", "assign-me"]);
    expect(issueActionShortcut(k("D", { shiftKey: true }), issue)).toBe("due-date");
    expect(issueActionShortcut(k("S", { shiftKey: true }), issue)).toBeNull();
  });
  it("needs a focused, editable issue and stays out of text fields and menus", () => {
    expect(issueActionShortcut(k("s"), { ...issue, hasIssue: false })).toBeNull();
    expect(issueActionShortcut(k("s"), { ...issue, canEdit: false })).toBeNull();
    expect(issueActionShortcut(k("s"), { ...issue, editing: true })).toBeNull();
    expect(issueActionShortcut(k("s"), { ...issue, overlayOpen: true })).toBeNull();
    expect(issueActionShortcut(k("s", { metaKey: true }), issue)).toBeNull();
  });
  it("gives L to labels while an issue is focused and to the list layout otherwise", () => {
    const view = { editing: false, overlayOpen: false, canEdit: true };
    expect(issueShortcut(k("l"), view)).toBe("list");
    expect(issueShortcut(k("l"), { ...view, issueFocused: true })).toBeNull();
    expect(issueShortcut(k("b"), { ...view, issueFocused: true })).toBe("board");
  });
});

describe("chat typing focus", () => {
  it("redirects printable keys, including shortcut letters", () => {
    for (const c of ["a", "c", "f", "V", "@", "#", " ", "Dead"]) expect(shouldFocusChatComposer(key(c), chat)).toBe(true);
  });
  it("does not steal focus from another editor or overlay", () => {
    expect(shouldFocusChatComposer(key("a"), { ...chat, editing: true })).toBe(false);
    expect(shouldFocusChatComposer(key("a"), { ...chat, overlayOpen: true })).toBe(false);
    expect(shouldFocusChatComposer(key("a"), { ...chat, canWrite: false })).toBe(false);
  });
  it("preserves keyboard activation, navigation, IME and modifier shortcuts", () => {
    for (const c of ["Enter", "Tab", "ArrowDown", "Escape", "Backspace"]) expect(shouldFocusChatComposer(key(c), chat)).toBe(false);
    expect(shouldFocusChatComposer(key(" "), { ...chat, controlHasFocus: true })).toBe(false);
    for (const extra of [{ isComposing: true }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) expect(shouldFocusChatComposer(key("c", extra), chat)).toBe(false);
  });
});
