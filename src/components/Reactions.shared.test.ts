// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, api: vi.fn(async () => ({})), useStore: () => ({ state: store.initialState, dispatch: vi.fn() }) };
});
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
  kind: "session", id: "s1", label: "Alice's laptop", scopes: ["client"], expiresAt: 1, reactor: "p_alice",
}))));
const { setLocale } = await import("@/lib/i18n");
const { ReactionChips } = await import("./Reactions");

it("on a workspace several people share, knows the viewer's own reactions by the key the server gave their session", async () => {
  setLocale("en");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const message: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "Shall I send it?", reactions: [
    { emoji: "👍", by: "p_alice", name: "alice@example.test" },
    { emoji: "👎", by: "p_bob", name: "bob@example.test" },
  ] };
  await act(async () => root.render(createElement(ReactionChips, { threadId: "t1", message })));
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  const chips = [...host.querySelectorAll("button")].map((chip) => [chip.textContent, chip.getAttribute("aria-pressed"), chip.getAttribute("title")]);
  expect(chips).toEqual([["👍", "true", "You"], ["👎", "false", "bob@example.test"]]);
  await act(async () => root.unmount());
  host.remove();
});
