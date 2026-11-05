// @vitest-environment happy-dom
// Picking a bot from the @ list sends its id with the words, so the bot picked is the one reached even when another
// bot has the same name. Typed names carry no ids. The desktop app and the web app share this composer.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [scout, analyst, chief], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: () => null }));

import { Composer } from "./Composer";

const scout: Bot = {
  id: "scout", threadId: "scout-thread", name: "Scout", title: "Support agent", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const analyst: Bot = { ...scout, id: "quill-analyst", threadId: "analyst-thread", name: "Quill", title: "Analyst", color: "teal" };
const chief: Bot = { ...scout, id: "quill-chief", threadId: "chief-thread", name: "Quill", title: "", color: "purple", chiefOfStaff: true };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: [scout.id, analyst.id, chief.id],
  defaultResponder: { kind: "member", botId: scout.id }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
};
const drafts = [`group:${room.id}:${room.threadId}`, `bot:${scout.id}:${scout.threadId}`];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of drafts) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  for (const id of drafts) restoreComposerDraft(id, { text: "", attachments: [] });
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = () => container.querySelector("textarea")!;
function type(draftId: string, text: string) {
  flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
  input().setSelectionRange(text.length, text.length);
  flushSync(() => input().dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true })));
}
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
function pick(name: string, role: string) {
  const option = options().find((one) => one.textContent?.includes(name) && one.textContent.includes(role));
  if (!option) throw new Error(`no ${name}, ${role} in the @ list: ${options().map((one) => one.textContent).join(" | ")}`);
  flushSync(() => option.click());
}
function send() {
  flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}
const sent = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "sendGroup" || action.type === "send");

describe("a room's @ list", () => {
  beforeEach(() => flushSync(() => root.render(createElement(Composer, { group: room, members: [scout, analyst, chief] }))));

  it("shows each Quill by its role, and sends the picked one's id", () => {
    type(drafts[0]!, "@Qu");
    expect(options().map((one) => one.textContent)).toEqual([expect.stringContaining("Analyst"), expect.stringContaining("Chief of Staff")]);
    pick("Quill", "Chief of Staff");
    expect(input().value).toBe("@Quill ");
    send();
    expect(sent()).toEqual([expect.objectContaining({ type: "sendGroup", groupId: room.id, text: "@Quill", mentions: [chief.id] })]);
  });

  it("sends a typed name with no ids, and forgets a pick once its line is sent", () => {
    type(drafts[0]!, "@Qu");
    pick("Quill", "Analyst");
    send();
    type(drafts[0]!, "@Quill check the numbers");
    send();
    expect(sent().map((action) => action.mentions)).toEqual([[analyst.id], []]);
  });

  it("keeps the pick with words a failed send hands back", () => {
    type(drafts[0]!, "@Qu");
    pick("Quill", "Chief of Staff");
    send();
    flushSync(() => sent()[0]!.onError());
    expect(input().value).toBe("@Quill ");
    send();
    expect(sent().map((action) => action.mentions)).toEqual([[chief.id], [chief.id]]);
  });
});

describe("a one-to-one chat's @ list", () => {
  it("sends the picked teammate's id too", () => {
    flushSync(() => root.render(createElement(Composer, { bot: scout })));
    type(drafts[1]!, "ask @Qu");
    pick("Quill", "Analyst");
    send();
    expect(sent()).toEqual([expect.objectContaining({ type: "send", botId: scout.id, text: "ask @Quill", mentions: [analyst.id] })]);
  });
});
