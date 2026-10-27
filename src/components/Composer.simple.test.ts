// @vitest-environment happy-dom
// Simple mode's composer: a round + holding attach, Finish together, the thread's approval level and the call mode,
// and a round call button in the bot's colour. Advanced mode keeps its row of buttons.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { MAUS_COLORS } from "@/lib/mascot";
import { onCallStartRequest } from "@/lib/call-start-request";
import { setCallMode } from "@/lib/call-mode";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  liveCall: null as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: (props: Record<string, unknown>) => {
  fixture.groupCall = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [bot.id, peer.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [],
};

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const plus = () => container.querySelector<HTMLElement>("[data-composer-plus]")?.closest("button") ?? null;
const menu = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const item = (key: string) => document.body.querySelector<HTMLButtonElement>(`[data-menu-key="${key}"]`);
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
function openPlus() {
  click(plus());
  expect(menu()).not.toBeNull();
}

beforeEach(() => {
  fixture.advanced = false;
  fixture.liveCall = null;
  setCallMode("turns");
  fixture.call = null;
  fixture.groupCall = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of [`bot:${bot.id}:${bot.threadId}`, `group:${room.id}:${room.threadId}`]) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Simple composer in a bot chat", () => {
  it("puts attach, work until done and the approval level behind a round +, and fills the call button with the bot's colour", () => {
    render({ bot });
    expect(plus()?.getAttribute("aria-label")).toBe("Add");
    expect(container.querySelector('button[aria-label="Attach a file"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Ask for approval for"]')).toBeNull();
    expect(container.querySelector('[aria-label="Work until done"]')).toBeNull();
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer", fill: MAUS_COLORS.purple });
    openPlus();
    expect([...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key")))
      .toEqual(["attach", "goal", "approval", "call:turns", "call:live"]);
    expect(menu()!.textContent).toContain("Work until done");
    expect(menu()!.textContent).toContain("Before Atlas acts");
    expect(menu()!.textContent).toContain("Call mode");
  });

  it("leaves the area behind and below the composer see-through, with no solid backdrop", () => {
    render({ bot });
    expect(container.querySelector("[data-composer-backdrop]")).toBeNull();
  });

  it("attaches through the same file picker as the paperclip", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ bot });
    openPlus();
    click(item("attach"));
    expect(picker).toHaveBeenCalledOnce();
    expect(plus()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts the call in the chosen mode through the call button, as its mode menu did", () => {
    const started = vi.fn();
    const stop = onCallStartRequest("atlas", started);
    render({ bot });
    openPlus();
    click(item("call:live"));
    expect(started).toHaveBeenCalledExactlyOnceWith("live");
    stop();
  });

  it("offers no call while Live is the mode and its line is held on another device, as the hidden call button", () => {
    const started = vi.fn();
    const stop = onCallStartRequest("atlas", started);
    setCallMode("live");
    fixture.liveCall = { callId: "phone-call", botId: "atlas", threadId: "atlas-thread", client: "ios", voice: "marin", startedAt: 1, status: "live" };
    render({ bot });
    openPlus();
    for (const key of ["call:turns", "call:live"]) {
      expect(item(key)?.disabled, key).toBe(true);
      click(item(key));
    }
    expect(started).not.toHaveBeenCalled();
    stop();
  });

  it("changes this thread's approval level from the submenu", () => {
    render({ bot });
    openPlus();
    click(item("approval"));
    const submenu = document.body.querySelector<HTMLElement>("[data-sidebar-popover-submenu]")!;
    expect(submenu.textContent).toContain("Command allowlist");
    const ask = submenu.querySelector('[data-menu-key="approval:ask"]')!;
    expect(ask.querySelector(".lucide-check")).not.toBeNull();
    click(submenu.querySelector('[data-menu-key="approval:full"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "atlas", threadId: "atlas-thread", patch: { approvalMode: "full" } });
  });
});

describe("the composer after Set me up", () => {
  it("asks for the job and shows a chip to stop it while the conversation waits, and neither once it does not", () => {
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "New thread", createdAt: 1, setupRequest: { at: 2 } }] } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Tell Atlas what you'd like help with");
    expect(container.querySelector("[data-setup-request]")?.textContent).toContain("Atlas is ready to be set up");
    expect(container.querySelector(`[aria-label="Stop setting up Atlas"]`)).not.toBeNull();
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "New thread", createdAt: 1 }] } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Atlas");
    expect(container.querySelector("[data-setup-request]")).toBeNull();
  });
});

describe("the Simple composer in a group chat", () => {
  it("offers Finish together in the + menu and keeps the Goal chip in view while it is on", () => {
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector('[aria-label="Finish together"]')).toBeNull();
    expect(fixture.groupCall).toMatchObject({ group: { id: "room" }, placement: "composer", fill: "var(--color-accent)" });
    openPlus();
    expect([...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"))).toEqual(["attach", "goal"]);
    click(item("goal"));
    const chip = container.querySelector('[aria-label="Finish together"]');
    expect(chip?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toContain("finish together");
    openPlus();
    expect(item("goal")!.querySelector(".lucide-check")).not.toBeNull();
    click(chip);
    expect(container.querySelector('[aria-label="Finish together"]')).toBeNull();
  });
});

describe("the Advanced composer", () => {
  it("keeps the paperclip, the approval shield and the split call button, with no +", () => {
    fixture.advanced = true;
    render({ bot });
    expect(plus()).toBeNull();
    expect(container.querySelector('button[aria-label="Attach a file"]')).not.toBeNull();
    expect(container.querySelector('[aria-haspopup="menu"][aria-label$="for Claude"]')).not.toBeNull();
    expect(fixture.call).toMatchObject({ placement: "composer" });
    expect(fixture.call?.fill).toBeUndefined();
    expect(container.querySelector("[data-composer-backdrop]")).not.toBeNull();
  });

  it("keeps the room's Goal chip and its header call button", () => {
    fixture.advanced = true;
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector('[aria-label="Finish together"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(fixture.groupCall).toBeNull();
  });
});
