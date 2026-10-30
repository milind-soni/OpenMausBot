// @vitest-environment happy-dom
// Simple mode's composer: one pill with a round + (attach, Work until done or Finish together, Teach a task), a chip for a
// mode only while this conversation turns it on, and one round button in the bot's tone that calls, sends or stops.
// Advanced keeps its row of buttons.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";
import { userBubbleTone } from "@/lib/user-bubble-tone";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
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
const menu = () => document.body.querySelector<HTMLElement>("[data-composer-menu]");
const popover = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const item = (key: string) => document.body.querySelector<HTMLButtonElement>(`[data-menu-key="${key}"]`);
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
/** The bot's own button: its bubble's fill and ink, with the darker hover and press steps. */
function expectBotButton(button: HTMLElement | null, color: Bot["color"]) {
  const tone = botButtonTone(color);
  expect(button?.className.split(" ")).toContain(BOT_BUTTON);
  expect(button?.style.getPropertyValue("--bot-button")).toBe(tone.fill);
  expect(button?.style.getPropertyValue("--bot-button-ink")).toBe(tone.ink);
  expect(button?.style.getPropertyValue("--bot-button-hover")).toBe(tone.hover);
  expect(button?.style.getPropertyValue("--bot-button-pressed")).toBe(tone.pressed);
}
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');

function openPlus() {
  click(plus());
  expect(menu()).not.toBeNull();
}

beforeEach(() => {
  fixture.advanced = false;
  fixture.liveCall = null;
  fixture.config = undefined;
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
  it("is one pill: a round + with three rows, the field, and one round button in the bot's tone", () => {
    render({ bot });
    expect(plus()?.getAttribute("aria-label")).toBe("Add");
    const pill = container.querySelector('[data-tour="composer"]')!.className.split(" ");
    expect(pill).toEqual(expect.arrayContaining(["rounded-[22px]", "bg-composer", "p-2", "ring-[0.5px]", "hover:ring-ink/[0.22]", "focus-within:ring-ink/[0.22]",
      "[transition:border-radius_300ms,box-shadow_150ms]"]));
    expect(pill.filter((name) => name.startsWith("shadow"))).toEqual(["shadow-[0_2px_8px_-1px_rgb(0_0_0/0.05),0_1px_2px_rgb(0_0_0/0.03),0_0_0_1px_rgb(228_228_228/0.04)]"]);
    expect(container.querySelector("[data-composer-row]")!.className).not.toContain("flex-wrap");
    expect(container.querySelector("[data-composer-actions]")!.className.split(" ")).toContain("gap-2");
    expect(container.querySelector("[data-composer-plus]")!.className.split(" ")).toEqual(expect.arrayContaining(["size-7", "bg-ink/[0.05]", "ring-inset", "text-ink-tertiary"]));
    expect(container.querySelector('button[aria-label="Attach a file"]')).toBeNull();
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    const tone = userBubbleTone("purple");
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer", fill: tone.background, ink: tone.ink });
    openPlus();
    expect([...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"))).toEqual(["attach", "goal", "teach"]);
    expect([...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.textContent)).toEqual(["Attach files", "Work until done", "Teach a task"]);
    const row = menu()!.querySelector("[data-menu-key='attach']")!.className.split(" ");
    expect(row).toEqual(expect.arrayContaining(["h-[34px]", "gap-2", "px-3", "text-[15px]"]));
    expect(menu()!.className.split(" ")).toEqual(expect.arrayContaining(["popover-surface", "rounded-[14px]", "w-max", "min-w-[200px]", "max-w-[280px]"]));
  });

  it("starts a /learn draft from Teach a task, ahead of anything already typed", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "how I file expenses", attachments: [] });
    render({ bot });
    openPlus();
    click(item("teach"));
    expect(container.querySelector("textarea")!.value).toBe("/learn how I file expenses");
  });

  it("opens the file picker straight from the + when attaching is its only row", () => {
    fixture.config = { features: { skillAuthoring: false } };
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ group: { ...room, dm: true }, members: [bot, peer] });
    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
    expect(attach.getAttribute("aria-haspopup")).toBeNull();
    click(attach);
    expect(picker).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("keeps the plain placeholder while the bot works and says what Send does in the bot's terms", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and this", attachments: [] });
    render({ bot: { ...bot, busy: true } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Atlas");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Sends when Atlas is done"]')!;
    expect(send.getAttribute("title")).toBe("Sends when Atlas is done");
  });

  it("rounds its corners in from 22 to 18 once the message takes a second line", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "one\ntwo", attachments: [] });
    render({ bot });
    const pill = container.querySelector('[data-tour="composer"]')!;
    expect(pill.hasAttribute("data-multiline")).toBe(true);
    expect(pill.className.split(" ")).toContain("rounded-[18px]");
  });

  it("sets the composer on plain canvas from its top edge down, with no fade above it", () => {
    render({ bot });
    const backdrop = container.querySelector("[data-composer-backdrop]")!.className.split(" ");
    expect(backdrop).toEqual(expect.arrayContaining(["bg-app", "top-0", "-bottom-4", "-left-5", "-right-5"]));
    expect(backdrop.some((name) => /gradient|blur|^from-|^to-|^opacity/.test(name))).toBe(false);
  });

  it("attaches through the same file picker as the paperclip", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ bot });
    openPlus();
    click(item("attach"));
    expect(picker).toHaveBeenCalledOnce();
    expect(plus()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("turns its round button into Send while there is text, in the bot's colour", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
    render({ bot });
    const send = sendButton()!;
    expect(send.className.split(" ")).toContain("size-7");
    expectBotButton(send, "purple");
    expect(send.className).not.toMatch(/\bbg-accent\b|brightness/);
    expect(fixture.call).toBeNull();
    render({ bot: { ...bot, color: "yellow" } });
    expectBotButton(sendButton(), "yellow");
  });

  it("turns its round button into Stop while the bot works, and keeps a quiet Stop beside Send while you type", () => {
    const busy = { ...bot, busy: true };
    render({ bot: busy });
    const slot = container.querySelector<HTMLButtonElement>('[data-composer-stop="slot"]')!;
    expect(slot.getAttribute("aria-label")).toBe("Stop this turn");
    expectBotButton(slot, "purple");
    expect(fixture.call).toBeNull();
    click(slot);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "interrupt", botId: "atlas", threadId: "atlas-thread" });

    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and also this", attachments: [] });
    render({ bot: busy });
    expect(container.querySelector('[data-composer-stop="beside"]')).not.toBeNull();
    expect(container.querySelector('[data-composer-stop="slot"]')).toBeNull();
  });

  it("shows the approval level as a chip only while this conversation overrides the bot, in the panel's words", () => {
    render({ bot: { ...bot, approvalMode: "full" } });
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    const task = { threadId: bot.threadId, title: "New thread", createdAt: 1 };
    render({ bot: { ...bot, tasks: [{ ...task, approvalMode: "full" }] } });
    const chip = container.querySelector("[data-approval-chip]")!;
    expect(chip.getAttribute("data-approval-chip")).toBe("full");
    expect(chip.textContent).toBe("Just do it");
    click(chip.closest("button"));
    const level = popover()!;
    expect(level.textContent).toContain("Ask me first");
    expect(level.textContent).toContain("Command allowlist");
    expect(level.querySelector('[data-menu-key="approval:full"] .lucide-check')).not.toBeNull();
    click(level.querySelector('[data-menu-key="approval:ask"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "atlas", threadId: "atlas-thread", patch: { approvalMode: "ask" } });
  });

  it("shows Work until done as a chip with a × only while it is on, and turns it off from there", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [], channelMode: "goal" });
    render({ bot });
    const chip = container.querySelector<HTMLButtonElement>("[data-goal-chip]")!;
    expect(chip.textContent).toBe("Work until done");
    expect(chip.querySelector(".lucide-x")).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe("Turn off Work until done");
    expect(chip.hasAttribute("aria-pressed")).toBe(false);
    expect(chip.className.split(" ")).toEqual(expect.arrayContaining(["h-7", "gap-1", "px-2.5", "text-[13px]"]));
    click(chip);
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
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
  it("offers Finish together in the + menu and keeps its chip in view while it is on", () => {
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Launch planning");
    expect(fixture.groupCall).toMatchObject({ group: { id: "room" }, placement: "composer", fill: "var(--color-accent)", ink: "var(--color-accent-ink)" });
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "hello room", attachments: [] });
    render({ group: room, members: [bot, peer] });
    const send = sendButton()!;
    expect(send.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(send.style.backgroundColor).toBe("var(--color-accent)");
    expect(send.style.color).toBe("var(--color-accent-ink)");
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "", attachments: [] });
    render({ group: room, members: [bot, peer] });
    openPlus();
    expect([...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"))).toEqual(["attach", "goal", "teach"]);
    click(item("goal"));
    const chip = container.querySelector("[data-goal-chip]");
    expect(chip?.getAttribute("aria-label")).toBe("Turn off Finish together");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toContain("finish together");
    openPlus();
    expect(item("goal")!.querySelector(".lucide-check")).not.toBeNull();
    click(chip);
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
  });

  it("keeps the room's @ hint only when the room answers to mentions", () => {
    render({ group: { ...room, defaultResponder: { kind: "mentions" } }, members: [bot, peer] });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Launch planning (@ to bring a bot in)");
  });
});

describe("the Advanced composer", () => {
  it("keeps the paperclip, the approval shield and the split call button, with no +, on Simple's floating surface", () => {
    fixture.advanced = true;
    render({ bot });
    expect(plus()).toBeNull();
    expect(container.querySelector('[data-tour="composer"]')!.className.split(" ")).toEqual(expect.arrayContaining(["rounded-2xl", "bg-composer", "ring-[0.5px]", "shadow-(--shadow-float)"]));
    expect(container.querySelector('button[aria-label="Attach a file"]')).not.toBeNull();
    expect(container.querySelector('[aria-haspopup="menu"][aria-label$="for Claude"]')).not.toBeNull();
    expect(fixture.call).toMatchObject({ placement: "composer" });
    expect(fixture.call?.fill).toBeUndefined();
    expect(container.querySelector("[data-composer-backdrop]")!.className.split(" ")).toContain("top-1/2");
  });

  it("sends with the bot's own button too, and keeps the accent in a room", () => {
    fixture.advanced = true;
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
    render({ bot: { ...bot, color: "teal" } });
    const send = sendButton()!;
    expect(send.className.split(" ")).toContain("size-8");
    expectBotButton(send, "teal");
    expect(send.className).not.toMatch(/\bbg-accent\b|text-white/);
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "hello room", attachments: [] });
    render({ group: room, members: [bot, peer] });
    expect(sendButton()!.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(sendButton()!.style.backgroundColor).toBe("var(--color-accent)");
  });

  it("keeps the room's Goal chip and its header call button", () => {
    fixture.advanced = true;
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector('[aria-label="Finish together"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(fixture.groupCall).toBeNull();
  });
});
