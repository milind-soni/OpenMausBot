// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));

const { BotEditorStore, initialState } = await import("@/state/store");
const { PermissionsSection } = await import("./PermissionsSection");
type Derived = Parameters<typeof PermissionsSection>[0]["derived"];

const base: Bot = {
  id: "pepper", name: "Pepper", threadId: "current", title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "claude", model: "fixture" }, approvalMode: "ask",
  tasks: [{ threadId: "current", title: "Current thread", createdAt: 1, approvalMode: "ask" }],
};
const dispatch = vi.fn();
let host: HTMLDivElement;
let root: Root;

function render(bot: Bot, trustedModesAvailable = false, others: Bot[] = []) {
  const derived = {
    patch: (patch: object) => dispatch({ type: "updateBot", botId: bot.id, patch }),
    engine: { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" },
    canCoordinate: true, approvalMode: bot.approvalMode ?? "ask", trustedModesAvailable,
    sectionName: "General", currentChief: undefined,
  } as unknown as Derived;
  flushSync(() => root.render(createElement(BotEditorStore, {
    value: { state: { ...initialState, bots: [bot, ...others] }, dispatch,
      flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
    children: createElement(PermissionsSection, { bot, derived }),
  })));
}
const choose = (label: string) => {
  flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    .find((button) => button.textContent?.startsWith(label));
  if (!item) throw new Error(`No ${label} level offered`);
  flushSync(() => item.click());
};
const dialogs = () => document.querySelectorAll('[role="alertdialog"], [role="dialog"]').length;

beforeEach(() => {
  dispatch.mockReset();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Full access in bot settings", () => {
  it.each([false, true])("applies to the bot and every thread at once, with no dialog (desktop bridge: %s)", (bridge) => {
    render(base, bridge);
    choose("Full access");
    expect(dialogs()).toBe(0);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "updateBot", botId: "pepper", patch: { approvalMode: "full", applyToAllThreads: true },
    });
  });

  it("re-applies Full to every thread from its button, with no dialog and no desktop bridge", () => {
    render({ ...base, approvalMode: "full" });
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Apply Full access to all threads");
    expect(button).toBeDefined();
    flushSync(() => button!.click());
    expect(dialogs()).toBe(0);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "updateBot", botId: "pepper", patch: { approvalMode: "full", applyToAllThreads: true },
    });
  });

  it("still warns before Auto on this computer", () => {
    render({ ...base, computer: "local" });
    choose("Approve for me");
    expect(dispatch).not.toHaveBeenCalled();
    expect(dialogs()).toBe(1);
  });
});

describe("PermissionsSection parts", () => {
  it("leaves Chief of Staff and peer checks out of a page that asks only for approvals", () => {
    const derived = {
      patch: vi.fn(), engine: { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" },
      canCoordinate: true, approvalMode: "ask", trustedModesAvailable: false, sectionName: "General", currentChief: undefined,
    } as unknown as Derived;
    flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state: { ...initialState, bots: [base] }, dispatch,
        flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
      children: createElement(PermissionsSection, { bot: base, derived, parts: ["approval", "outbound"] }),
    })));
    expect(host.textContent).toContain("Approval level");
    expect(host.textContent).toContain("Sending on your behalf");
    expect(host.textContent).not.toContain("Chief of Staff");
    expect(host.textContent).not.toContain("Ask me before contacting other bots");
    render(base);
    expect(host.textContent).toContain("Chief of Staff");
    expect(host.textContent).toContain("Ask me before contacting other bots");
  });
});

describe("who a bot talks to", () => {
  const quill: Bot = { ...base, id: "quill", name: "Quill", threadId: "quill-main", tasks: [] };
  const button = () => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Let it talk to every bot");

  it("says nothing more for a bot that talks to every bot, the default", () => {
    render(base, false, [quill]);
    expect(host.textContent).not.toContain("Set up to talk only to");
    expect(button()).toBeUndefined();
  });

  it("names the bots a peers list keeps it to, and lets a person open it to every bot in one click", () => {
    render({ ...base, peers: ["quill", "deleted-bot"] }, false, [quill]);
    expect(host.textContent).toContain("Set up to talk only to Quill.");
    flushSync(() => button()!.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "updateBot", botId: "pepper", patch: { peers: null, acknowledgePeerScope: true } });
  });

  it("says so when the list leaves it no one to talk to", () => {
    render({ ...base, peers: [] }, false, [quill]);
    expect(host.textContent).toContain("Set up not to talk to other bots.");
    expect(button()).toBeDefined();
  });
});
