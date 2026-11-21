import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { HandoffStatusLine } from "../../shared/handoff-status";
import type { Bot, Message, Task } from "@/state/store";

const coder = { id: "coder", threadId: "coder-main", name: "Coder", color: "green", messages: [], tasks: [] } as unknown as Bot;
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [coder] }, dispatch: vi.fn() }) };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
const { HandoffStatusChip, handoffStatusText } = await import("./HandoffStatusChip");
const { ThreadChip } = await import("./ThreadChip");
const { attentionRowStatus } = await import("./SidebarBotActivity");

beforeEach(() => setLocale("en"));
const line = (over: Partial<HandoffStatusLine>): HandoffStatusLine => ({ id: "a1", state: "working", at: 1, ...over });

describe("hand-off status chip", () => {
  it("says each state in a few words", () => {
    expect(handoffStatusText(line({ state: "claimed" }))).toBe("Claimed");
    expect(handoffStatusText(line({ state: "working" }))).toBe("Working");
    expect(handoffStatusText(line({ state: "waiting", waitingOn: { kind: "bot", name: "Writer" } }))).toBe("Waiting on Writer");
    expect(handoffStatusText(line({ state: "waiting", waitingOn: { kind: "person" } }))).toBe("Waiting on you");
    expect(handoffStatusText(line({ state: "done" }))).toBe("Done");
    expect(handoffStatusText(line({ state: "failed", why: "The engine stalled" }))).toBe("Failed: The engine stalled");
    expect(handoffStatusText(line({ state: "failed" }))).toBe("Failed");
  });

  it("names the asker on a team, and a private one only as private", () => {
    expect(handoffStatusText(line({ state: "waiting", waitingOn: { kind: "person", name: "Mira" }, forPerson: { name: "Mira" } }))).toBe("Waiting on Mira · for Mira");
    expect(handoffStatusText(line({ forPerson: { name: "Mira", private: true } }))).toBe("Working · for Mira (private)");
  });

  it("is a status, not a control", () => {
    const html = renderToStaticMarkup(createElement(HandoffStatusChip, { line: line({ state: "done" }) }));
    expect(html).toContain('data-handoff-status="done"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<button");
  });

  it("sits beside the Sent-to pill that opens the work", () => {
    const row = { id: "r", role: "bot", kind: "activity", at: 1, tool: { name: "Sent to Coder", ok: true },
      threadRef: { botId: "coder", threadId: "work", title: "Build the page" }, handoff: line({ state: "waiting", waitingOn: { kind: "bot", name: "Writer" } }) } as Message;
    const html = renderToStaticMarkup(createElement(ThreadChip, { message: row, threadId: "lead" }));
    expect(html).toContain('data-thread-chip="work"');
    expect(html).toContain('data-handoff-status="waiting"');
    expect(html).toContain("Waiting on Writer");
    const plain = renderToStaticMarkup(createElement(ThreadChip, { message: { ...row, handoff: undefined }, threadId: "lead" }));
    expect(plain).not.toContain("data-handoff-status");
  });

  it("gives the inbox's row for the work conversation the same words", () => {
    const task = { threadId: "work", title: "Build the page", createdAt: 0, busy: true, queued: false, handoff: line({ forPerson: { name: "Mira" } }) } as Task & { queued: boolean };
    const { handoff: _none, ...plain } = task;
    expect(attentionRowStatus(task).label).toBe("Working · for Mira");
    expect(attentionRowStatus({ ...task, busy: false, waitingForTeammates: true, handoff: line({ state: "waiting", waitingOn: { kind: "bot", name: "Writer" } }) }).label).toBe("Waiting on Writer");
    expect(attentionRowStatus({ ...task, busy: false, activity: "waiting-on-you", handoff: line({ state: "waiting", waitingOn: { kind: "person" } }) }).label).toBe("Waiting on you");
    expect(attentionRowStatus({ ...plain, busy: false, activity: "waiting-on-you" }).label).toBe("Waiting");
  });
});
