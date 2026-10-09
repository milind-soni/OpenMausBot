// @vitest-environment happy-dom
// When the New divider goes: not while the person sits at the end it opened
// on, but once they leave it and read their way back down. Reduced motion
// skips the fade and drops it at once.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnreadDivider } from "./use-unread-divider";
import { UNREAD_DIVIDER_FADE_MS, UNREAD_DIVIDER_LINGER_MS } from "@/lib/unread-divider";
import { BotEditorStore, initialState, type Action, type AppState, type Message } from "@/state/store";

const messages: Message[] = [
  { id: "u1", role: "user", kind: "text", text: "hi", at: 1 },
  { id: "b2", role: "bot", kind: "text", text: "hello", at: 2 },
];
const state: AppState = { ...initialState, unreadDivider: { threadId: "t", messageId: "b2" } };
let dispatched: Action[];
let root: Root;
let shown: { messageId: string | null; fading: boolean };

function Probe({ following }: { following: boolean }) {
  shown = useUnreadDivider({ threadId: "t", messages, following });
  return null;
}
async function draw(following: boolean) {
  const value = { state, dispatch: (action: Action) => { dispatched.push(action); }, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(BotEditorStore, { value, children: createElement(Probe, { following }) })));
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes("reduce") })) as typeof window.matchMedia;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  dispatched = [];
  reduceMotion(false);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useUnreadDivider", () => {
  it("stays while the person has not left the end it opened on", async () => {
    await draw(true);
    await wait(10 * (UNREAD_DIVIDER_LINGER_MS + UNREAD_DIVIDER_FADE_MS));
    expect(shown).toEqual({ messageId: "b2", fading: false });
    expect(dispatched).toEqual([]);
  });

  it("fades after they scroll away and read back down to the end", async () => {
    await draw(true);
    await draw(false);
    await wait(UNREAD_DIVIDER_LINGER_MS);
    expect(shown.fading).toBe(false);
    await draw(true);
    await wait(UNREAD_DIVIDER_LINGER_MS);
    expect(shown).toEqual({ messageId: "b2", fading: true });
    await wait(UNREAD_DIVIDER_FADE_MS);
    expect(dispatched).toEqual([{ type: "unreadDividerDone", threadId: "t" }]);
  });

  it("drops it without the fade under reduced motion", async () => {
    reduceMotion(true);
    await draw(false);
    await draw(true);
    await wait(UNREAD_DIVIDER_LINGER_MS);
    expect(shown.fading).toBe(false);
    expect(dispatched).toEqual([{ type: "unreadDividerDone", threadId: "t" }]);
  });
});
