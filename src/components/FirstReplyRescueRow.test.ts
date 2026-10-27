// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAiSwitch, useAiSwitch } from "@/lib/ai-switch";
import { setAdvancedMode } from "@/lib/interface-mode";
import { forgetStops } from "@/lib/stop-turn";
import { runtimeFrameAction, StoreContext, type Bot, type InstanceInfo, type Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { FirstReplyRescue } from "../../shared/first-reply-rescue";
import { PERSON_STOPPED_TURN_NAME, STOPPED_TURN_NAME } from "../../shared/client-cancel";
import { CancelledTurnRow } from "./CancelledTurnRow";
import { StatusActivityRow } from "./StatusActivityRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rescue: FirstReplyRescue = { botId: "bot-1", threadId: "thread-1", turnId: "turn-1", requestMessageId: "ask-1", instanceId: "opencodeGo", ai: "OpenCode" };
const AT = 50_000;
const row = (payload: FirstReplyRescue = rescue): Message => ({
  id: "m-1", at: AT, role: "bot", kind: "activity", turnId: payload.turnId,
  tool: { name: payload.settled ? "notice: OpenCode answered after a slow start." : "notice: Maus hasn't heard back from OpenCode yet.", ok: true, rescue: payload },
} as Message);
const bot = (busy: boolean, turnStartedAt = AT - 20_000): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Maus", title: "", description: "", notifications: true, color: "green", unread: false, busy,
  messages: [{ id: "ask-1", at: 1, role: "user", kind: "text", text: "Plan my week" }],
  modelSelection: { instanceId: "opencodeGo", model: "free" }, tasks: [{ threadId: "thread-1", title: "Chat", createdAt: 1, busy, ...(busy ? { turnStartedAt } : {}) }],
} as unknown as Bot);
const engine = { instanceId: "opencodeGo", displayName: "OpenCode", driverKind: "opencodeGo", models: { default: "free", options: [] } } as unknown as InstanceInfo;
const frame = (type: string, turnId: string) => ({ eventId: `e-${turnId}`, provider: "fake", threadId: "thread-1", turnId, createdAt: "", type, ok: true }) as unknown as RuntimeEvent;

let host: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
const opened = { header: vi.fn(), panel: vi.fn() };
let headerBot: Bot | null = null;

/** The pickers this chat could draw; Switch AI must reach exactly one of them. */
function Pickers() {
  headerBot = useAiSwitch({ bot: bot(true), threadId: "thread-1", contained: false, dispatch: vi.fn(), setOpen: opened.header }).bot;
  useAiSwitch({ bot: bot(true), threadId: "thread-1", contained: true, dispatch: vi.fn(), setOpen: opened.panel });
  return null;
}
function render(message: Message, options: { busy?: boolean; turnStartedAt?: number; groups?: unknown[] } = {}) {
  const value = { state: { bots: [bot(options.busy ?? true, options.turnStartedAt)], instances: [engine], groups: options.groups ?? [] }, dispatch } as never;
  act(() => root.render(createElement(StoreContext.Provider, { value }, createElement(Pickers), createElement(StatusActivityRow, { message }))));
}
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === label);

beforeEach(() => {
  dispatch = vi.fn();
  opened.header.mockReset();
  opened.panel.mockReset();
  forgetStops();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  setAdvancedMode(false);
  delete (window as { ogb?: unknown }).ogb;
  resetAiSwitch();
});

describe("first-reply rescue row", () => {
  it("says who is waiting on which AI, as a quiet notice with two ways out", () => {
    render(row());
    expect(host.textContent).toContain("Maus hasn't heard back from OpenCode yet.");
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button("Switch AI")).toBeDefined();
    expect(button("Connect your subscription")).toBeDefined();
  });

  it("goes away once the AI starts answering", () => {
    render(row({ ...rescue, settled: true }));
    expect(host.textContent).toBe("");
  });

  it("tells an ended turn's notice as history", () => {
    render(row({ ...rescue, over: true }));
    expect(host.textContent).toBe("Maus didn't hear back from OpenCode.");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it.each([
    ["the chat is idle again", () => render(row(), { busy: false })],
    ["the live frames name another turn", () => { runtimeFrameAction(frame("turn.started", "turn-2")); render(row()); }],
    ["the running turn started after it", () => render(row(), { turnStartedAt: AT + 1 })],
  ])("keeps no live buttons once %s", (_label, show) => {
    show();
    expect(host.textContent).toContain("Maus hasn't heard back from OpenCode yet.");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("opens Settings at the AI providers for Connect your subscription", () => {
    render(row());
    act(() => button("Connect your subscription")!.click());
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "engines" }]]);
  });

  it("in Simple mode, opens the bot panel's picker for this turn, and leaves the turn running", () => {
    setAdvancedMode(false);
    render(row());
    act(() => button("Switch AI")!.click());
    expect(dispatch.mock.calls).toEqual([[expect.objectContaining({ type: "toggleSettings", open: true, section: "model", botId: "bot-1" })]]);
    expect(opened.panel).toHaveBeenCalledWith(true);
    expect(opened.header).not.toHaveBeenCalled();
  });

  it("in Advanced mode, opens the header's model chip for this turn, and leaves the turn running", () => {
    setAdvancedMode(true);
    render(row());
    act(() => button("Switch AI")!.click());
    expect(dispatch).not.toHaveBeenCalled();
    expect(opened.header).toHaveBeenCalledWith(true);
    expect(opened.panel).not.toHaveBeenCalled();
  });

  it("hands the picker back to the running turn once the row's own turn is over", () => {
    setAdvancedMode(true);
    render(row());
    act(() => button("Switch AI")!.click());
    expect(headerBot!.busy).toBe(false);
    render(row({ ...rescue, over: true }));
    expect(headerBot!.busy).toBe(true);
  });

  it.each([
    ["a remote client in Advanced mode, whose header has no model chip", () => {
      setAdvancedMode(true);
      (window as { ogb?: unknown }).ogb = { remoteClient: { active: true } };
      render(row());
    }],
    ["a room, whose header has no model chip", () => render(row({ ...rescue, groupId: "room-1" }), { groups: [{ id: "room-1", busyBotId: "bot-1", turnStartedAt: AT - 1 }] })],
  ])("offers no Switch AI for %s", (_label, show) => {
    show();
    expect(button("Switch AI")).toBeUndefined();
    expect(button("Connect your subscription")).toBeDefined();
  });
});

describe("stopped row", () => {
  it("tells the person they stopped it, in plain grey words", () => {
    act(() => root.render(createElement(CancelledTurnRow, { name: PERSON_STOPPED_TURN_NAME })));
    expect(host.textContent).toBe("You stopped this.");
    act(() => root.render(createElement(CancelledTurnRow, { name: STOPPED_TURN_NAME })));
    expect(host.textContent).toBe("Stopped");
  });
});
