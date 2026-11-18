// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), navigate: vi.fn(), api: vi.fn() }));
vi.mock("@/lib/focus-message", () => ({ landOnSearchHit: fixture.navigate }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState,
      forkPanel: { kind: "bot", ownerId: "bot", threadId: "fork", messages: [], activeLeafId: null,
        loading: false, loadId: "load", loadFailed: false } }, dispatch: fixture.dispatch }),
    api: fixture.api,
  };
});

import { ChatFindBar } from "./ChatFindBar";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("focuses a fork search hit without selecting or switching the main conversation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockImplementation(async (path: string) => path.startsWith("/api/search?") ? { hits: [{
    botId: "bot", name: "Bot", threadId: "fork", messageId: "copied", role: "bot", kind: "text", at: 1,
    snippet: "Matching text", matchStart: 0, matchLength: 8, onActivePath: true,
  }] } : {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ChatFindBar, { threadId: "fork", inForkPanel: true, onClose: () => {} })));
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Matching");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({
    type: "focusMessage", threadId: "fork", messageId: "copied", matchText: "Matching",
  }));
  expect(fixture.navigate).not.toHaveBeenCalled();
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "focusMessage", threadId: "fork", messageId: "copied", matchText: "Matching" });
  await act(async () => root.unmount());
  host.remove();
});
