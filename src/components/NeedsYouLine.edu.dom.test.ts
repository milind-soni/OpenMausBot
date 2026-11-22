// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState } from "@/state/store";

const fixture = vi.hoisted(() => ({ opened: [] as unknown[] }));
vi.mock("./bot-panel/panel-link", () => ({ openBotSettings: (...args: unknown[]) => fixture.opened.push(args.slice(1)) }));

const { NeedsYouLine } = await import("./TeamOwner");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("names the proposal and opens the bot's Memory settings, where it is decided", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const state = { ...initialState, bots: [] } as AppState;
  const item = { kind: "edu-proposal" as const, id: "edu:k", at: 1, botId: "luna", proposalId: "K-iso", title: "Use ISO dates", global: true };
  await act(async () => root.render(createElement(StoreContext.Provider, { value: { state, dispatch: vi.fn() } as never }, createElement(NeedsYouLine, { item }))));
  expect(host.textContent).toBe("Edu wants to remember “Use ISO dates”");
  await act(async () => host.querySelector("button")!.click());
  expect(fixture.opened).toEqual([["memory", { botId: "luna", page: "memory" }]]);
  act(() => root.unmount());
  host.remove();
});
