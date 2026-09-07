// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("@/components/DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: {} }),
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const { createContext, useContext, useMemo, useReducer } = await import("react");
  const Ctx = createContext<{
    state: ReturnType<typeof actual.useStore>["state"];
    dispatch: ReturnType<typeof actual.useStore>["dispatch"];
    flushBotPatches: ReturnType<typeof actual.useStore>["flushBotPatches"];
    refreshInstances: ReturnType<typeof actual.useStore>["refreshInstances"];
    refreshModels: ReturnType<typeof actual.useStore>["refreshModels"];
  } | null>(null);

  return {
    ...actual,
    StoreProvider: ({ children }: { children: React.ReactNode }) => {
      const [state, dispatch] = useReducer(actual.reducer, actual.initialState);
      const value = useMemo(
        () => ({
          state,
          dispatch,
          flushBotPatches: async () => null,
          refreshInstances: async () => {},
          refreshModels: async () => {},
        }),
        [state, dispatch],
      );
      return createElement(Ctx.Provider, { value }, children);
    },
    useStore: () => {
      const ctx = useContext(Ctx);
      if (!ctx) throw new Error("useStore outside provider");
      return ctx;
    },
    api: vi.fn(async () => ({ drift: false, file: "/tmp/bot/soul.md", fileText: "", soul: "" })),
  };
});

const { BotSettingsDialog } = await import("./BotSettingsDialog");
const { StoreProvider, useStore } = await import("@/state/store");

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    title: "Scout",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    soul: "Original standing instructions.",
    ...overrides,
  };
}

let capturedState: ReturnType<typeof useStore>["state"] | null = null;

function StateSpy() {
  const { state } = useStore();
  capturedState = state;
  return null;
}

function Harness({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "botPatched", bot: { ...bot, messages: [] } });
    dispatch({ type: "select", id: bot.id });
    dispatch({ type: "toggleSettings", open: true, section: "soul" });
  }, [dispatch, bot]);
  const currentBot = state.bots.find((b) => b.id === bot.id);
  if (!state.settingsOpen || !currentBot) return null;
  return createElement(BotSettingsDialog, { bot: currentBot });
}

describe("BotSettingsDialog close after SOUL textarea edit", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    capturedState = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("closes and unmounts after editing the SOUL textarea and clicking the X", async () => {
    const bot = makeBot();

    act(() => {
      root.render(
        createElement(StoreProvider, null,
          createElement(StateSpy),
          createElement(Harness, { bot }),
        ),
      );
    });

    // Let the initial useEffect dispatches + SoulField refresh flush.
    await act(async () => {
      await Promise.resolve();
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(capturedState?.settingsOpen).toBe(true);

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    act(() => {
      textarea!.value = "Edited SOUL text";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const closeButton = container.querySelector('button[aria-label="Close settings"]');
    expect(closeButton).not.toBeNull();

    act(() => {
      (closeButton as HTMLButtonElement).click();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(capturedState?.settingsOpen).toBe(false);
  });
});
