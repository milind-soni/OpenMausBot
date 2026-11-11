// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null, instances: [{ instanceId: "test", driverKind: "claudeAgent", displayName: "Test" } as InstanceInfo] },
    dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => true,
}));
const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { renderTrigger: (state: { open: boolean }) => unknown }) => props.renderTrigger({ open: false }),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span"),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));

const { ChatView } = await import("./ChatView");
const { noteLiveReplyEvent, noteLiveReplyMessage, resetLiveReplies } = await import("@/state/live-reply");
const { resetTurnLive } = await import("@/state/turn-status");

const THREAD = "selected";
const started = Date.UTC(2026, 10, 11, 12, 0, 0);
const bot = (messages: Message[], busy = true): Bot => ({
  id: "bot", threadId: THREAD, name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined, messages,
  modelSelection: { instanceId: "test", model: "m" },
});
const ask: Message = { id: "ask", role: "user", kind: "text", at: started, text: "Plan my week" };

let seq = 0;
const frame = (event: Partial<RuntimeEvent>) => ({
  eventId: `e${++seq}`, provider: "claudeAgent", threadId: THREAD, createdAt: new Date().toISOString(), turnId: "t1", ...event,
} as RuntimeEvent);
const engine = (event: Partial<RuntimeEvent>) => act(() => noteLiveReplyEvent(frame(event)));
const say = (delta: string) => engine({ type: "content.delta", streamKind: "assistant_text", delta } as Partial<RuntimeEvent>);

let host: HTMLDivElement;
let root: Root;
const render = (shown: Bot) => act(() => root.render(createElement(ChatView, { bot: shown })));
const log = () => host.querySelector('[role="log"]')!;
const liveRows = () => [...log().querySelectorAll('[data-mid^="live:"]')];
const rowOf = (id: string) => log().querySelector(`[data-mid="${id}"]`);
const occurrences = (text: string) => (log().textContent ?? "").split(text).length - 1;
/** A row's markup with the ids that name it taken out: what the eye sees. */
const looks = (row: Element) => row.outerHTML.replace(/live:[^"]+|data-mid="[^"]+"|data-citation-source="[^"]+"/g, "");

beforeEach(() => {
  vi.useFakeTimers({ now: started + 5_000 });
  resetTurnLive();
  resetLiveReplies();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  mode.advanced = true;
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([["Advanced", true], ["Simple", false]])("a streaming reply in %s mode", (_name, advanced) => {
  it("grows in place and is replaced by the saved message in the same frame, never shown twice", () => {
    mode.advanced = advanced;
    engine({ type: "turn.started" });
    render(bot([ask]));
    expect(liveRows()).toHaveLength(0);

    say("Monday: gym. ");
    expect(liveRows()).toHaveLength(1);
    expect(liveRows()[0]!.textContent).toContain("Monday: gym.");
    say("Tuesday: **review** the bud");
    expect(liveRows()).toHaveLength(1);
    expect(liveRows()[0]!.querySelector("strong")?.textContent, "drawn as Markdown while it streams").toBe("review");
    expect(liveRows()[0]!.textContent, "a word still being written waits").not.toContain("bud");
    say("get.");
    const text = "Monday: gym. Tuesday: **review** the budget.";
    engine({ type: "item.completed", itemType: "assistant_text", text } as Partial<RuntimeEvent>);
    expect(liveRows()[0]!.textContent).toContain("the budget.");
    expect(liveRows()[0]!.querySelector('[data-testid="message-actions"]')?.hasAttribute("inert"), "no actions on words still arriving").toBe(true);
    const live = looks(liveRows()[0]!);

    const saved: Message = { id: "m-saved", role: "bot", kind: "text", at: started + 5_000, text, turnId: "t1", parentId: "ask" };
    act(() => noteLiveReplyMessage(THREAD, saved));
    expect(liveRows(), "the frame is in but the transcript has not drawn it: the streamed bubble stays").toHaveLength(1);
    expect(occurrences("the budget.")).toBe(1);

    render(bot([ask, saved]));
    expect(liveRows()).toHaveLength(0);
    expect(rowOf("m-saved")).not.toBeNull();
    expect(occurrences("the budget."), "one reply, not two").toBe(1);
    expect(looks(rowOf("m-saved")!).replace(/ inert=""/g, ""), "the saved bubble looks like the streamed one").toBe(live.replace(/ inert=""/g, ""));
    expect(rowOf("m-saved")!.querySelector(".turn-answer"), "it does not play in again").toBeNull();
  });
});

describe("a streaming reply's end", () => {
  it("is gone when the turn fails or stops before the reply was saved", () => {
    engine({ type: "turn.started" });
    render(bot([ask]));
    say("Half an answer ");
    expect(liveRows()).toHaveLength(1);
    engine({ type: "turn.completed", ok: false } as Partial<RuntimeEvent>);
    expect(liveRows()).toHaveLength(0);
  });

  it("belongs to its own conversation: another one opened shows none of it", () => {
    engine({ type: "turn.started" });
    render(bot([ask]));
    say("Private words ");
    render({ ...bot([], false), threadId: "other" });
    expect(liveRows()).toHaveLength(0);
    expect(occurrences("Private words")).toBe(0);
    render(bot([ask]));
    expect(liveRows()[0]!.textContent, "coming back shows it again, still growing").toContain("Private words");
  });
});

describe("a turn of several messages from an engine that names no items", () => {
  it("streams each message after the last, swaps each for its saved one, and leaves nothing behind", () => {
    engine({ type: "turn.started" });
    render(bot([ask]));
    say("Checking your calendar ");
    say("first. ");
    engine({ type: "item.completed", itemType: "assistant_text", text: "Checking your calendar first." } as Partial<RuntimeEvent>);
    const first: Message = { id: "m1", role: "bot", kind: "text", at: started + 5_000, text: "Checking your calendar first.", turnId: "t1", parentId: "ask" };
    act(() => noteLiveReplyMessage(THREAD, first));
    engine({ type: "item.started", itemType: "tool", itemId: "c1", title: "ls -la" } as Partial<RuntimeEvent>);
    const step: Message = { id: "s1", role: "bot", kind: "activity", at: started + 5_000, tool: { name: "ls -la", itemId: "c1" }, turnId: "t1", parentId: "m1" };
    say("Monday is ");
    expect(occurrences("Checking your calendar first."), "the first message stays drawn until the transcript has it").toBe(1);
    render(bot([ask, first, step]));
    expect(occurrences("Checking your calendar first.")).toBe(1);
    expect(liveRows()).toHaveLength(1);
    expect(liveRows()[0]!.textContent, "the second message stands alone").not.toContain("Checking");
    say("free. ");
    engine({ type: "item.completed", itemType: "assistant_text", text: "Monday is free." } as Partial<RuntimeEvent>);
    const second: Message = { id: "m2", role: "bot", kind: "text", at: started + 5_000, text: "Monday is free.", turnId: "t1", parentId: "s1" };
    act(() => noteLiveReplyMessage(THREAD, second));
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    expect(occurrences("Monday is free.")).toBe(1);
    render(bot([ask, first, step, second], false));
    expect(liveRows()).toHaveLength(0);
    expect(occurrences("Checking your calendar first.")).toBe(1);
    expect(occurrences("Monday is free.")).toBe(1);
    const order = [...log().querySelectorAll("[data-mid]")].map((row) => row.getAttribute("data-mid"));
    expect(order.indexOf("m1")).toBeLessThan(order.indexOf("m2"));
  });
});

