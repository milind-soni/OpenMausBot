// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OneWorkspaceView, RosterBot } from "../../shared/one-workspace";
import { mergeWorkspace, setOneWorkspaceForTests } from "@/lib/one-workspace";
import { OtherSideBotRow, TwinCopyLine } from "./OneWorkspace";

const bot = (id: string, extra: Partial<RosterBot> = {}): RosterBot => ({ id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), title: "", color: "blue", avatarUrl: null, unread: false, ...extra });
const fromCloud: OneWorkspaceView = { page: "cloud", twinHome: "computer", cloudName: "My Cloud",
  other: { side: "computer", state: "ready", at: 1, bots: [bot("scout", { threads: ["t-scout", "t-trip"] })], rooms: [], sections: [] } };
let host: HTMLDivElement, root: Root;
const open = vi.fn(async () => {});

beforeEach(() => {
  open.mockClear();
  window.ogb = { oneWorkspace: { open, view: async () => fromCloud, onView: () => () => {}, take: async () => null } } as unknown as typeof window.ogb;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  setOneWorkspaceForTests(null);
  delete window.ogb;
});

it("on My Cloud's page, a bot's row opens its home on this computer, at the chat this page has open when the home has it", () => {
  const merged = mergeWorkspace(fromCloud, { bots: [{ id: "scout", threadId: "t-trip" }], groups: [], selectedId: "scout" });
  flushSync(() => root.render(createElement(OtherSideBotRow, { bot: merged.bots[0]!, merged, density: "comfortable" })));
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-other-side-bot="scout"]')!.click());
  expect(open).toHaveBeenCalledWith({ side: "computer", id: "scout", threadId: "t-trip" });
});

it("the line above a copy's chat opens the home copy, at this conversation", () => {
  setOneWorkspaceForTests({ view: fromCloud });
  flushSync(() => root.render(createElement(TwinCopyLine, { bot: { id: "scout", name: "Scout", threadId: "t-scout" } })));
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-twin-copy]")!.click());
  expect(open).toHaveBeenCalledWith({ side: "computer", id: "scout", threadId: "t-scout" });
});
