// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type useStore } from "@/state/store";
import {
  parseShortcutChord,
  resetStartFreshShortcutCache,
  setStartFreshShortcut,
} from "@/lib/start-fresh-shortcut";
import { useStartFreshShortcutAction } from "./start-fresh-shortcut";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  modalOpen: false,
}));

vi.mock("@/state/store-select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store-select")>();
  return {
    ...actual,
    useStoreSelector: () => fixture.modalOpen,
  };
});

const store = { state: {}, dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null) } as unknown as ReturnType<typeof useStore>;

function Harness(props: Parameters<typeof useStartFreshShortcutAction>[0]) {
  useStartFreshShortcutAction(props);
  return createElement("textarea", { "data-testid": "composer" });
}

let host: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof vi.fn>;

const render = (overrides: Partial<Parameters<typeof useStartFreshShortcutAction>[0]> = {}) =>
  act(async () => {
    root.render(
      createElement(BotEditorStore, {
        value: store,
        children: createElement(Harness, {
          botId: "b1",
          threadId: "t1",
          active: true,
          mayWrite: true,
          busy: false,
          messageCount: 2,
          atFreshStart: false,
          ...overrides,
        }),
      }),
    );
  });

const pressDefault = (opts: Partial<KeyboardEventInit> = {}, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: "K",
      code: "KeyK",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...opts,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const calls = () => fetched.mock.calls.map(([url, init]) => [String(url), JSON.parse(String((init as RequestInit).body))]);

beforeEach(() => {
  fixture.modalOpen = false;
  resetStartFreshShortcutCache();
  fetched = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetched);
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

describe("useStartFreshShortcutAction", () => {
  it("calls /api/bots/:id/start-fresh for the active thread even when composer textarea has focus", async () => {
    await render();
    const textarea = host.querySelector("textarea")!;
    textarea.focus();
    await pressDefault({}, textarea);
    expect(calls()).toEqual([["/api/bots/b1/start-fresh", { threadId: "t1" }]]);
  });

  it("respects custom bindings and does nothing when cleared", async () => {
    await act(async () => {
      setStartFreshShortcut(parseShortcutChord("mod+shift+l")!);
    });
    await render();

    await pressDefault();
    expect(calls()).toEqual([]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls()).toEqual([["/api/bots/b1/start-fresh", { threadId: "t1" }]]);

    await act(async () => {
      setStartFreshShortcut(null);
    });
    await pressDefault({ key: "L", code: "KeyL" });
    expect(calls()).toHaveLength(1);
  });

  it("follows Start fresh availability guards (busy, empty, already fresh, read-only, inactive, modal, dialog, repeat)", async () => {
    for (const overrides of [
      { busy: true },
      { messageCount: 0 },
      { atFreshStart: true },
      { mayWrite: false },
      { active: false },
    ]) {
      fetched.mockClear();
      await render(overrides);
      await pressDefault();
      expect(calls(), JSON.stringify(overrides)).toEqual([]);
    }

    fetched.mockClear();
    fixture.modalOpen = true;
    await render();
    await pressDefault();
    expect(calls()).toEqual([]);

    fixture.modalOpen = false;
    await render();
    await pressDefault({ repeat: true });
    expect(calls()).toEqual([]);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const input = document.createElement("input");
    dialog.append(input);
    document.body.append(dialog);
    await pressDefault({}, input);
    expect(calls()).toEqual([]);
    dialog.remove();
  });

  it("does not double-submit while a start-fresh request is already in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    fetched.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    await render();

    await pressDefault();
    await pressDefault();
    expect(calls()).toHaveLength(1);

    await act(async () => {
      resolveFetch(new Response("{}", { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
