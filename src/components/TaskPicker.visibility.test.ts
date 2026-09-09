import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ showThreads: true, queued: {} as Record<string, unknown[]>, dispatch: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { pendingQueued: fixture.queued }, dispatch: fixture.dispatch }),
}));

const { TaskPicker, BotActivityPicker, GroupTaskPicker } = await import("./TaskPicker");
const bot: Bot = {
  id: "pepper", name: "Pepper", color: "green", threadId: "current", title: "", description: "",
  notifications: true, unread: false, busy: true, messages: [], modelSelection: { instanceId: "fake", model: "fake" },
  tasks: [
    { threadId: "current", title: "Current chat", createdAt: 1, busy: true, activity: "working" },
    { threadId: "idle", title: "Quiet history", createdAt: 2, busy: false },
    { threadId: "waiting", title: "Approval needed", createdAt: 3, busy: false, activity: "waiting-on-you" },
    { threadId: "working", title: "Research", createdAt: 4, busy: true, activity: "working" },
    { threadId: "queued", title: "Next job", createdAt: 5, busy: false },
    { threadId: "unread", title: "Finished reply", createdAt: 6, unread: true },
  ],
};
beforeEach(() => { fixture.showThreads = true; fixture.queued = {}; fixture.dispatch.mockClear(); });

describe("optional bot thread picker", () => {
  it("keeps the usual picker when threads are shown", () => {
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toContain('aria-label="All threads"');
  });

  it("hides quiet histories and creation but keeps sibling activity reachable", () => {
    fixture.showThreads = false;
    fixture.queued = { queued: [{ queueId: "pending" }] };
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toBe("");
    const markup = renderToStaticMarkup(createElement(BotActivityPicker, { bot }));
    expect(markup).toContain('aria-label="Other activity (4)"');
    expect(markup).toContain('value="waiting">Approval needed · Waiting');
    expect(markup).toContain('value="working">Research · Working');
    expect(markup).toContain('value="queued">Next job · Queued');
    expect(markup).toContain('value="unread">Finished reply · Unread');
    expect(markup).not.toContain("Quiet history");
    expect(markup).toContain("Current chat");
    expect(markup).not.toContain('value="current"');
    expect(markup).not.toContain("All threads");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("Rename");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("selects the exact sibling without creating or stopping work", () => {
    fixture.showThreads = false;
    const picker = BotActivityPicker({ bot });
    const select = picker!.props.children[0];
    expect(select.type).toBe("select");
    select.props.onChange({ target: { value: "waiting" } });
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "pepper", threadId: "waiting" });
  });

  it("renders nothing when only the selected conversation is working", () => {
    fixture.showThreads = false;
    expect(renderToStaticMarkup(createElement(BotActivityPicker, { bot: { ...bot, tasks: bot.tasks!.slice(0, 2) } }))).toBe("");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not remove channel history controls", () => {
    fixture.showThreads = false;
    const group: Group = { id: "team", name: "Team", threadId: "team-current", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", createdAt: 1, unread: false, messages: [],
      tasks: [{ threadId: "team-current", title: "Channel discussion", createdAt: 1 }] };
    expect(renderToStaticMarkup(createElement(GroupTaskPicker, { group }))).toContain('aria-label="All threads"');
  });
});
