// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState } from "@/state/store";
import { BrowserViewerPill, usePaneHold } from "./viewer-pill-host";

let container: HTMLDivElement, root: Root;
let hold: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hold = vi.fn(async (input: { held: boolean }) => ({ held: input.held }));
  (window as unknown as { ogb: unknown }).ogb = { browserPane: { show: vi.fn(), hold } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (window as unknown as { ogb?: unknown }).ogb; vi.unstubAllGlobals(); });

const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const button = (name: string) => [...container.querySelectorAll("button")].find((one) => one.textContent?.trim() === name || one.getAttribute("aria-label") === name);

function PaneViewer({ onCollapse }: { onCollapse: () => void }) {
  const pane = usePaneHold("scout", null, true);
  return createElement(BrowserViewerPill, { bot: { id: "scout" }, you: pane.held, pending: false, onTake: () => pane.set(true), onStop: () => pane.set(false), onDone: () => pane.set(false), onCollapse });
}

async function show(state: Partial<AppState>, onCollapse = vi.fn()) {
  const value = { state: { ...initialState, ...state }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(StoreContext.Provider, { value }, createElement(PaneViewer, { onCollapse }))));
  return onCollapse;
}

it("takes and hands back the desktop app's pane through its hold, and lets a hold it took go when it goes", async () => {
  await show({});
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Watching");
  await act(async () => button("Take control")!.click()); await settle();
  expect(hold).toHaveBeenLastCalledWith({ botId: "scout", threadId: null, held: true });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("You're in control");
  await act(async () => button("Stop")!.click()); await settle();
  expect(hold).toHaveBeenLastCalledWith({ botId: "scout", threadId: null, held: false });
  await act(async () => button("Take control")!.click()); await settle();
  await act(async () => root.unmount());
  expect(hold).toHaveBeenLastCalledWith({ botId: "scout", threadId: null, held: false });
  root = createRoot(container);
});

it("during a request, I'm done answers it, lets the pane go and folds the viewer", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const help = { botId: "scout", threadId: "t1", messageId: "m1", site: "", place: "browser" as const, instruction: "Sign in." };
  const onCollapse = await show({ computerControl: { scout: { held: false, helpReason: null, help } } } as unknown as Partial<AppState>);
  await act(async () => button("Take control")!.click()); await settle();
  await act(async () => button("I'm done")!.click()); await settle();
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/bots/scout/sign-in-cards/m1/done");
  expect(hold).toHaveBeenLastCalledWith({ botId: "scout", threadId: null, held: false });
  expect(onCollapse).toHaveBeenCalledOnce();
});

it("gives the pane back to the bot when the request ends anywhere else, as on the card or by expiry", async () => {
  function Holder({ open }: { open: boolean }) {
    const pane = usePaneHold("scout", null, true, open);
    return createElement("button", { onClick: () => pane.set(true) }, pane.held ? "held" : "free");
  }
  const value = { state: initialState, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const render = (open: boolean) => act(async () => root.render(createElement(StoreContext.Provider, { value }, createElement(Holder, { open }))));
  await render(true);
  await act(async () => container.querySelector("button")!.click()); await settle();
  expect(container.textContent).toBe("held");
  await render(false); await settle();
  expect(hold).toHaveBeenLastCalledWith({ botId: "scout", threadId: null, held: false });
  expect(container.textContent).toBe("free");
});
