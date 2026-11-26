// @vitest-environment happy-dom
// Advanced mode's composer on a wider screen: the field on its own line, then one quiet footer row with a + that holds
// every tool, the model, chips only for what this conversation changes, and on the right Context, the mic and one round
// button that calls, or sends while there is something to send.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";

const fixture = vi.hoisted(() => ({
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  model: null as Record<string, unknown> | null,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot, peer], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: (props: Record<string, unknown>) => {
  fixture.groupCall = props;
  return null;
} }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (props: Record<string, unknown>) => {
  fixture.model = props;
  return createElement("span", { "data-test-model": true });
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
const task = { threadId: bot.threadId, title: "New thread", createdAt: 1 };

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const plus = () => container.querySelector<HTMLElement>("[data-composer-plus]")?.closest("button") ?? null;
const popover = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const item = (key: string) => document.body.querySelector<HTMLButtonElement>(`[data-menu-key="${key}"]`);
const keys = () => [...popover()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"));
const classes = (selector: string) => container.querySelector(selector)!.className.split(" ");
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
const type = (value: string) => {
  const field = container.querySelector("textarea")!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
function openPlus() {
  click(plus());
  expect(popover()).not.toBeNull();
}

beforeEach(() => {
  fixture.agentsMcp = true;
  fixture.config = undefined;
  fixture.call = null;
  fixture.groupCall = null;
  fixture.model = null;
  setCallMode("turns");
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

describe("the Advanced composer in a bot chat", () => {
  it("puts the field on its own line above one footer row, on the floating surface", () => {
    render({ bot });
    expect(classes('[data-tour="composer"]')).toEqual(expect.arrayContaining(["rounded-[18px]", "bg-composer", "ring-[0.5px]", "composer-shell", "shadow-(--shadow-composer)"]));
    expect(classes('[data-tour="composer"]')).not.toContain("shadow-(--shadow-float)");
    expect(classes(".mention-editor")).toContain("basis-full");
    expect(container.querySelector("[data-composer-row] > .mention-editor + [data-composer-tools]")).not.toBeNull();
    expect(classes("[data-composer-row]")).toContain("flex-wrap");
    expect(classes("[data-composer-actions]")).toContain("ms-auto");
    expect(classes("[data-composer-backdrop]")).toContain("top-1/2");
    type("a short one");
    expect(classes(".mention-editor")).toContain("basis-full");
  });

  it("keeps the footer calm: a quiet +, the model, Context, and one call button with no chevron of its own", () => {
    render({ bot });
    const tools = container.querySelector("[data-composer-tools]")!;
    expect(tools.querySelector("[data-composer-plus]")).not.toBeNull();
    expect(plus()?.getAttribute("aria-label")).toBe("Add");
    expect(classes("[data-composer-plus]")).toEqual(expect.arrayContaining(["size-8", "text-ink-secondary"]));
    for (const gone of ["Attach a file", "Teach a task", "Work until done"]) expect(container.querySelector(`button[aria-label="${gone}"]`)).toBeNull();
    expect(container.querySelector('[aria-label$="for Claude"]')).toBeNull();
    expect(container.querySelector('[data-testid="place-chip"]')).toBeNull();
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    expect(tools.querySelector("[data-test-model]")).not.toBeNull();
    expect(fixture.model).toMatchObject({ bot: { id: "atlas" }, threadId: "atlas-thread", quiet: true });
    expect(container.querySelector("[data-composer-context]")).not.toBeNull();
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer", modeMenu: false });
    expect(fixture.call?.fill).toBeUndefined();
  });

  it("holds attach, Work until done, Teach a task, where it works, the approval level and the call mode in the +", () => {
    render({ bot });
    openPlus();
    expect(keys()).toEqual(["attach", "goal", "teach", "place", "approval", "call:turns", "call:live"]);
    expect(item("approval")!.textContent).toContain("Before Atlas acts");
    expect(item("place")!.textContent).toContain("Works on");
  });

  it("attaches through the file picker", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ bot });
    openPlus();
    click(item("attach"));
    expect(picker).toHaveBeenCalledOnce();
  });

  it("starts a /learn draft from Teach a task, ahead of anything typed", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "how I file expenses", attachments: [] });
    render({ bot });
    openPlus();
    click(item("teach"));
    expect(container.querySelector("textarea")!.value).toBe("/learn how I file expenses");
  });

  it.each([
    ["skill authoring is off", () => { fixture.config = { features: { skillAuthoring: false } }; }],
    ["the engine can't run agents", () => { fixture.agentsMcp = false; }],
  ])("leaves Teach a task out when %s", (_, setup) => {
    setup();
    render({ bot });
    openPlus();
    expect(keys()).not.toContain("teach");
  });

  it("shows Work until done as a chip only while it is on", () => {
    render({ bot });
    openPlus();
    click(item("goal"));
    const chip = container.querySelector<HTMLButtonElement>("[data-goal-chip]")!;
    expect(chip.getAttribute("aria-label")).toBe("Turn off Work until done");
    click(chip);
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
  });

  it("changes the conversation's approval level from the +, then shows it as a chip while it differs from the bot's", () => {
    render({ bot });
    openPlus();
    click(item("approval"));
    click(item("approval:full"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "atlas", threadId: "atlas-thread", patch: { approvalMode: "full" } });
    render({ bot: { ...bot, tasks: [{ ...task, approvalMode: "full" }] } });
    const chip = container.querySelector("[data-approval-chip]")!;
    expect(chip.getAttribute("data-approval-chip")).toBe("full");
    expect(chip.textContent).toBe("Full access");
  });

  it("shows the place chip only while this conversation is pinned to a place", () => {
    render({ bot: { ...bot, tasks: [{ ...task, surface: "browser", surfaceAuto: true }] } });
    expect(container.querySelector('[data-testid="place-chip"]')).toBeNull();
    render({ bot: { ...bot, tasks: [{ ...task, surface: "browser" }] } });
    expect(container.querySelector('[data-testid="place-chip"]')?.getAttribute("aria-label")).toContain("Browser");
  });

  it("swaps the call button for Send while there is something to send, in the bot's colour, and drops the call modes", () => {
    render({ bot });
    expect(sendButton()).toBeNull();
    fixture.call = null;
    type("hello");
    expect(fixture.call).toBeNull();
    const send = sendButton()!;
    expect(send.className.split(" ")).toContain("size-8");
    const tone = botButtonTone("purple");
    expect(send.style.getPropertyValue("--bot-button")).toBe(tone.fill);
    openPlus();
    expect(keys().some((key) => key?.startsWith("call:"))).toBe(false);
  });

  it("keeps Stop and the call button while the bot works, with a queued message waiting to send", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and also this", attachments: [] });
    render({ bot: { ...bot, busy: true } });
    expect(container.querySelector('button[aria-label="Stop this turn"]')).not.toBeNull();
    expect(fixture.call).toMatchObject({ placement: "composer", modeMenu: false });
  });

  it("keeps the model in the footer while setup holds the field, with the tools put away", () => {
    render({ bot, locked: true });
    expect(plus()).toBeNull();
    expect(container.querySelector("[data-test-model]")).not.toBeNull();
  });
});

describe("the Advanced composer in a room", () => {
  it("offers Finish together in the +, shows no model, and keeps the room's accent Send", () => {
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector("[data-test-model]")).toBeNull();
    expect(fixture.groupCall).toBeNull();
    openPlus();
    expect(keys()).toEqual(["attach", "goal", "teach"]);
    expect(item("goal")!.textContent).toBe("Finish together");
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "hello room", attachments: [] });
    render({ group: room, members: [bot, peer] });
    expect(sendButton()!.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(sendButton()!.style.backgroundColor).toBe("var(--color-accent)");
  });
});
