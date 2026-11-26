// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_START_FRESH_SHORTCUT,
  formatCanonicalChord,
  readStartFreshShortcut,
  resetStartFreshShortcutCache,
} from "@/lib/start-fresh-shortcut";
import { StartFreshShortcutControl, StartFreshShortcutRow } from "./StartFreshShortcutControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const renderControl = (compact = false) => act(async () => {
  root.render(createElement(StartFreshShortcutControl, { compact }));
});

const renderRow = () => act(async () => {
  root.render(createElement(StartFreshShortcutRow));
});

const click = (selector: string) => act(async () => {
  host.querySelector<HTMLButtonElement>(selector)!.click();
});

const keyDownRecorder = (init: KeyboardEventInit) => act(async () => {
  const recorder = host.querySelector<HTMLButtonElement>("[data-start-fresh-recorder]")!;
  recorder.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});

beforeEach(() => {
  resetStartFreshShortcutCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  resetStartFreshShortcutCache();
  vi.unstubAllGlobals();
});

describe("StartFreshShortcutControl", () => {
  it("records a custom chord, allows clearing, and resets back to default", async () => {
    await renderControl();
    expect(host.querySelectorAll("kbd").length).toBeGreaterThan(0);
    expect(host.querySelector("[data-start-fresh-reset]")).toBeNull();

    await click("[data-start-fresh-change]");
    expect(host.querySelector("[data-start-fresh-recorder]")?.textContent).toBe("Press shortcut…");

    await keyDownRecorder({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    expect(host.querySelector("[data-start-fresh-recorder]")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-start-fresh-change]"));
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe("mod+shift+l");
    expect(host.querySelector("[data-start-fresh-reset]")).not.toBeNull();

    await click("[data-start-fresh-clear]");
    expect(readStartFreshShortcut()).toBeNull();
    expect(host.querySelector("[data-start-fresh-unset]")?.textContent).toBe("Not set");

    await click("[data-start-fresh-reset]");
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe(DEFAULT_START_FRESH_SHORTCUT);
    expect(host.querySelector("[data-start-fresh-reset]")).toBeNull();
  });

  it("rejects unmodified keys and built-in/reserved conflicts with inline alerts, and cancels on Escape without stealing focus on blur", async () => {
    await renderRow();
    await click("[data-start-fresh-change]");

    await keyDownRecorder({ key: "r", code: "KeyR" });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Include Command");
    expect(host.querySelector("[data-start-fresh-recorder]")).not.toBeNull();

    await keyDownRecorder({ key: "k", code: "KeyK", ctrlKey: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Open command palette");

    await keyDownRecorder({ key: "w", code: "KeyW", ctrlKey: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("reserved");

    await keyDownRecorder({ key: "Escape", code: "Escape" });
    expect(host.querySelector("[data-start-fresh-recorder]")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-start-fresh-change]"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe(DEFAULT_START_FRESH_SHORTCUT);

    // Blur should close recording without stealing focus back to Change.
    const external = document.createElement("button");
    document.body.append(external);
    await click("[data-start-fresh-change]");
    await act(async () => {
      external.focus();
      host.querySelector<HTMLButtonElement>("[data-start-fresh-recorder]")!.dispatchEvent(new FocusEvent("blur"));
    });
    expect(host.querySelector("[data-start-fresh-recorder]")).toBeNull();
    expect(document.activeElement).toBe(external);
    external.remove();
  });
});
