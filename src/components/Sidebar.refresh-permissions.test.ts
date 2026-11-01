// @vitest-environment happy-dom
import { createElement, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { SidebarThreadRow } from "./SidebarThreadRow";

const rows = vi.hoisted(() => new Map<string, ComponentProps<typeof SidebarThreadRow>>());
vi.mock("./SidebarThreadRow", async (original) => ({
  ...await original<typeof import("./SidebarThreadRow")>(),
  SidebarThreadRow: (props: ComponentProps<typeof SidebarThreadRow>) => {
    rows.set(props.task.threadId, props);
    return null;
  },
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));

const { initialState } = await import("@/state/store");
const { BotThreadList, botRowProps } = await import("./Sidebar");

const bot = (fields: Partial<Bot>): Bot => ({
  id: "pepper", name: "Pepper", threadId: "current", title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "claude", model: "fixture" },
  tasks: [
    { threadId: "current", title: "Current thread", createdAt: 2, approvalMode: "ask" },
    { threadId: "older", title: "Older thread", createdAt: 1, approvalMode: "ask" },
  ],
  ...fields,
});
const dispatch = vi.fn();
let host: HTMLDivElement;
let root: Root;
const render = (candidate: Bot) => flushSync(() => root.render(createElement(BotThreadList, {
  ...botRowProps(initialState, dispatch, candidate, { density: "comfortable", query: "", onMenu: vi.fn() }),
  selected: true,
})));
const refresh = (threadId: string) => flushSync(() => rows.get(threadId)!.onRefreshPermissions!({ threadId } as never));
const dialogs = () => document.querySelectorAll('[role="alertdialog"], [role="dialog"]').length;

beforeEach(() => {
  rows.clear();
  dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("refresh permissions from the sidebar", () => {
  it("copies Full access onto a thread at once, with no confirmation", () => {
    render(bot({ approvalMode: "full" }));
    refresh("older");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "refreshTaskPermissions", botId: "pepper", threadId: "older" });
    expect(dialogs()).toBe(0);
  });

  it("still shows the warning before copying Auto on this computer", () => {
    render(bot({ approvalMode: "auto", computer: "local" }));
    refresh("older");
    expect(dispatch).not.toHaveBeenCalled();
    expect(dialogs()).toBe(1);
  });
});
