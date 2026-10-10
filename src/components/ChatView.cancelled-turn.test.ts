// @vitest-environment happy-dom
import { createElement, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  showToolCalls: false,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.showToolCalls ? { features: { showToolCalls: true } } : null,
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: fixture.dispatch,
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
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { renderTrigger: (state: { open: boolean }) => unknown }) => props.renderTrigger({ open: false }),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span"),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));

const { ChatView } = await import("./ChatView");

const CANCELLED = "The request was cancelled by the client.";
const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

let host: HTMLDivElement;
let root: Root;
const render = (shown: Bot) => flushSync(() => root.render(createElement(ChatView, { bot: shown })));
const retry = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry"));

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.showToolCalls = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a cancelled turn", () => {
  const ask = { id: "ask", role: "user" as const, kind: "text" as const, at: 1, text: "Try the new model" };

  it("renders the provider sentence as a muted stop with Retry, and resends that message", () => {
    render({ ...bot, messages: [ask, { id: "cancel", role: "bot", kind: "text", at: 2, text: CANCELLED }] });
    const notice = host.querySelector("[role=status]:not([data-chathead-status])");
    expect(notice?.textContent).toContain("Stopped");
    expect(notice?.className).toContain("flex-wrap");
    expect(notice?.className).not.toMatch(/\b(?:ml-|mr-|left-|right-|text-left|text-right)/);
    expect(host.textContent).not.toContain(CANCELLED);
    expect(host.innerHTML).not.toContain("border-danger");
    const button = retry();
    expect(button).toBeTruthy();
    flushSync(() => button!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "editMessage",
      botId: "bot",
      threadId: "selected",
      messageId: "ask",
      text: "Try the new model",
    });
  });

  it("reads a legacy error row and a stored stop the same way", () => {
    render({ ...bot, messages: [ask, { id: "cancel", role: "bot", kind: "activity", at: 2, tool: { name: `error: ${CANCELLED}`, ok: false } }] });
    expect(host.textContent).toContain("Stopped");
    expect(host.textContent).not.toContain(CANCELLED);
    expect(host.innerHTML).not.toContain("border-danger");
    flushSync(() => root.render(createElement(ChatView, { bot: { ...bot, messages: [
      ask,
      { id: "cancel", role: "bot", kind: "activity", at: 2, tool: { name: "stopped: Stopped", ok: true } },
    ] } })));
    expect(host.textContent).toContain("Stopped");
    expect(host.textContent).not.toContain("stopped:");
    expect(retry()).toBeTruthy();
  });

  it("keeps a real error, including one that only mentions cancellation", () => {
    const cause = `${CANCELLED} See the logs.`;
    render({ ...bot, messages: [ask, { id: "error", role: "bot", kind: "activity", at: 2, tool: { name: `error: ${cause}`, ok: false } }] });
    expect(host.textContent).toContain(cause);
    expect(host.innerHTML).toContain("border-danger");
    expect(host.textContent).not.toContain("Stopped");
    expect(retry()).toBeTruthy();
  });

  it("offers Retry only on the latest turn, and not while the bot is busy", () => {
    const task = bot.tasks![0]!;
    render({
      ...bot,
      busy: true,
      tasks: [{ ...task, busy: true, activity: "working" }],
      messages: [ask, { id: "cancel", role: "bot", kind: "text", at: 2, text: CANCELLED }],
    });
    expect(host.textContent).toContain("Stopped");
    expect(retry()).toBeUndefined();
    render({ ...bot, messages: [
      ask,
      { id: "cancel", role: "bot", kind: "text", at: 2, text: CANCELLED },
      { id: "next", role: "user", kind: "text", at: 3, text: "A different request" },
    ] });
    expect(retry()).toBeUndefined();
  });
});
