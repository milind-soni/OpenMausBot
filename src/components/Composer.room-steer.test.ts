// @vitest-environment happy-dom
// A queued room message steers or stays queued; it never stops the room's turn and the work its head handed out.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const STEERS = "engine-that-steers";
const WAITS = "engine-that-waits";
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), room: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: {
      ...original.initialState,
      bots: [head, member],
      groups: [fixture.room],
      pendingQueued: { "room-thread": [{ queueId: "q1", text: "use the smaller model" }] },
      instances: [
        { instanceId: STEERS, driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: true } },
        { instanceId: WAITS, driverKind: "grok", displayName: "Grok", capabilities: { queueing: false } },
      ],
    },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: () => null }));

import { Composer } from "./Composer";

const head: Bot = {
  id: "head", threadId: "head-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: STEERS, model: "fake" },
};
const member: Bot = { ...head, id: "member", threadId: "member-thread", name: "Juniper", modelSelection: { instanceId: WAITS, model: "fake" } };
const room = (busyBotId: string | null): Group => ({
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [head.id, member.id],
  defaultResponder: { kind: "member", botId: head.id }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [], working: true, busyBotId,
});

let root: Root;
let container: HTMLDivElement;
const render = (group: Group) => {
  fixture.room = group;
  flushSync(() => root.render(createElement(Composer, { group, members: [head, member] })));
};
const dispatched = () => fixture.dispatch.mock.calls.map(([action]) => (action as { type: string }).type);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a queued message in a working room", () => {
  it("steers when no bot is marked busy, instead of stopping the room", () => {
    render(room(null));
    const steer = [...container.querySelectorAll("button")].find((button) => button.textContent === "Steer");
    expect(container.textContent).not.toContain("Stop and send");
    flushSync(() => steer!.click());
    expect(dispatched()).toContain("steerGroupQueued");
    expect(dispatched()).not.toContain("interruptGroup");
  });

  it("stays queued and says so when the busy bot cannot take a steer", () => {
    render(room(member.id));
    expect(container.textContent).not.toContain("Stop and send");
    expect(container.textContent).not.toMatch(/\bSteer\b/);
    expect(container.textContent).toContain("Queued. Sends when the room's current turn finishes.");
    expect(dispatched()).not.toContain("interruptGroup");
  });

  it("keeps the context menu beside Stop, for the members that are not the one at work", () => {
    render(room(member.id));
    expect(container.querySelector('[data-composer-actions] button[aria-label="Stop this turn"]')).not.toBeNull();
    expect(container.querySelector("[data-composer-context]")).not.toBeNull();
  });
});
