// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";

const fixture = vi.hoisted(() => ({
  admin: true,
  agentsMcp: true,
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
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
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


beforeEach(() => {
  fixture.admin = true;
  fixture.agentsMcp = true;
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

describe("the composer", () => {
  it("keeps the paperclip, the approval shield and the split call button, with no +", () => {
    render({ bot });
    expect(plus()).toBeNull();
    expect(container.querySelector('[data-tour="composer"]')!.className.split(" ")).toEqual(expect.arrayContaining(["rounded-2xl", "bg-composer", "ring-[0.5px]", "shadow-(--shadow-float)"]));
    expect(container.querySelector('button[aria-label="Attach a file"]')).not.toBeNull();
    expect(container.querySelector('[aria-haspopup="menu"][aria-label$="for Claude"]')).not.toBeNull();
    expect(fixture.call).toMatchObject({ placement: "composer" });
    expect(fixture.call?.fill).toBeUndefined();
    expect(container.querySelector("[data-composer-backdrop]")!.className.split(" ")).toContain("top-1/2");
  });

  it("offers Teach a task as its own button, which starts a /learn draft ahead of anything typed", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "how I file expenses", attachments: [] });
    render({ bot });
    const teach = container.querySelector<HTMLButtonElement>('button[aria-label="Teach a task"]');
    expect(teach).not.toBeNull();
    click(teach);
    expect(container.querySelector("textarea")!.value).toBe("/learn how I file expenses");
  });

  it("leaves Teach a task out when skill authoring is off", () => {
    fixture.config = { features: { skillAuthoring: false } };
    render({ bot });
    expect(container.querySelector('button[aria-label="Teach a task"]')).toBeNull();
  });

  it("leaves Teach a task out when the bot's engine can't run agents", () => {
    fixture.agentsMcp = false;
    render({ bot });
    expect(container.querySelector('button[aria-label="Teach a task"]')).toBeNull();
  });

  it("sends with the bot's own button too, and keeps the accent in a room", () => {
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
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector('[aria-label="Finish together"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(fixture.groupCall).toBeNull();
  });

  describe("with a message longer than one line", () => {
    const type = (value: string) => {
      const field = container.querySelector("textarea")!;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const classes = (selector: string) => container.querySelector(selector)!.className.split(" ");
    const stacked = () => classes(".mention-editor").includes("basis-full");
    /** A field 20 characters wide: longer text wraps onto a second 24px line. */
    const wrapPast20 = () => vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLTextAreaElement) { return this.value.length > 20 ? 48 : 24; });

    it("gives the text the full width above the buttons, and puts it back beside them on one line", () => {
      render({ bot });
      expect(stacked()).toBe(false);
      type("Okay I have done my outreach.\nAnother line of text.");
      expect(classes(".mention-editor")).toEqual(expect.arrayContaining(["order-first", "basis-full"]));
      expect(classes("[data-composer-row]")).toContain("flex-wrap");
      expect(classes("[data-composer-actions]")).toContain("ml-auto");
      type("Okay I have done my outreach.");
      expect(stacked()).toBe(false);
      expect(classes("[data-composer-row]")).not.toContain("flex-wrap");
    });

    it("stacks once the text wraps beside the buttons, and stays stacked until it is shorter than where it wrapped", () => {
      wrapPast20();
      render({ bot });
      type("a".repeat(25));
      expect(stacked()).toBe(true);
      // Wider on its own line, it would fit on one row there; it still must not flip back and forth.
      type("a".repeat(30));
      expect(stacked()).toBe(true);
      type("a".repeat(24));
      expect(stacked()).toBe(true);
      type("a".repeat(10));
      expect(stacked()).toBe(false);
    });

    it("measures each new message afresh, so a wrap from a narrower composer does not stick", () => {
      const wrap = wrapPast20();
      render({ bot });
      type("a".repeat(25));
      expect(stacked()).toBe(true);
      type("");
      // Wider now: 30 characters fit on the one row.
      wrap.mockImplementation(function (this: HTMLTextAreaElement) { return this.value.length > 40 ? 48 : 24; });
      type("a".repeat(30));
      expect(stacked()).toBe(false);
    });

    it("never stacks an empty field, even when its placeholder wraps", () => {
      vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(48);
      render({ bot });
      expect(stacked()).toBe(false);
    });

  });
});

it.each([false, true])("keeps Call for a shared viewer without Stop permission (waiting for teammates: %s)", waiting => {
  fixture.admin = false;
  fixture.config = { team: true };
  const shared: Bot = { ...bot, tasks: [{ threadId: bot.threadId, title: "Shared", createdAt: 1, busy: !waiting, waitingForTeammates: waiting, askedBy: { id: "other-person", name: "Other person" } }] };
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "Follow-up from another viewer", attachments: [] });
  render({ bot: shared });
  expect(container.querySelector('[aria-label="Stop this turn"]')).toBeNull();
  expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer" });
});
