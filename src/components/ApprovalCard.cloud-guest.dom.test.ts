// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const session = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("@/lib/session")>(), readSessionState: async () => session.state }));

// A browser tool call waiting for an answer in a chat, as the guest's and the owner's devices draw it.
const waiting: Message = {
  id: "browser-card", role: "bot", kind: "options", at: 1,
  card: { title: "Approval needed", subtitle: "agent_browser_status", options: ["Allow", "Deny"], requestId: "r1", tool: "mcp__browser__agent_browser_status" },
};
const GUEST = { kind: "session", id: "s1", label: "Guest phone", scopes: ["client"], expiresAt: 1, cloudGuest: true, openedThreads: ["t1"] };
const OWNER = { kind: "session", id: "s2", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 };
const NOTE = "The owner of this Cloud has to approve this.";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function shown(state: unknown, message: Message = waiting): Promise<string> {
  session.state = state;
  const { ApprovalCard } = await import("./ApprovalCard");
  await act(async () => { root.render(createElement(ApprovalCard, { message, threadId: "t1" })); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container.textContent ?? "";
}

describe("a waiting card on someone's My Cloud", () => {
  it("tells a guest the Cloud's owner has to approve it, and why", async () => {
    const text = await shown(GUEST);
    expect(text).toContain(NOTE);
    expect(text).toContain("whatever the bot's access level, because the bot uses the owner's browser and sign-ins");
  });

  it("shows the owner the card as before", async () => {
    expect(await shown(OWNER)).not.toContain(NOTE);
  });

  it("adds nothing once the card is answered", async () => {
    expect(await shown(GUEST, { ...waiting, card: { ...waiting.card!, answered: "allow" } })).not.toContain(NOTE);
  });
});
