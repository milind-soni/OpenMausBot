import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), showThreads: true }));
const scout: Bot = {
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "scout-main", title: "Main", createdAt: 1 },
    { threadId: "qa-245", title: "QA PR 245", createdAt: 2, openedBy: { botId: "ada", name: "Ada", at: 2 } },
    { threadId: "octopus", title: "Octopus facts", createdAt: 3, openedBy: { botId: "ada", name: "Ada", at: 3 }, closedBy: { botId: "ada", name: "Ada", at: 4 }, archivedAt: 4 },
  ],
};
const ada: Bot = { ...scout, id: "ada", threadId: "ada-main", name: "Ada", color: "orange", tasks: [{ threadId: "ada-main", title: "Main", createdAt: 1 }] };
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [scout, ada] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
import { ThreadChip } from "./ThreadChip";
import { BotAvatar } from "./Avatar";

const receipt = (threadId = "qa-245"): Message => ({
  id: "receipt", role: "bot", kind: "activity", at: 3,
  tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
  threadRef: { botId: "scout", threadId, title: "QA PR 245" },
});

type ElementProps = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (attribute in child.props) return child;
    const found = findElement(child.props.children, attribute);
    if (found) return found;
  }
}

beforeEach(() => { fixture.dispatch.mockClear(); fixture.showThreads = true; });

function findType(tree: ReactNode, type: unknown): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (child.type === type) return child;
    const found = findType(child.props.children, type);
    if (found) return found;
  }
}

describe("ThreadChip", () => {
  it("shows the bot that asked on the line that records a hand-off, and opens the archived hand-off thread", () => {
    const line: Message = { id: "asked", role: "bot", kind: "activity", at: 5,
      tool: { name: "Ada asked me: Octopus facts", ok: true, nameCode: "chat.notice.askedMe", nameParams: { bot: "Ada", title: "Octopus facts" } },
      threadRef: { botId: "scout", threadId: "octopus", title: "Octopus facts" }, askedBy: { botId: "ada", name: "Ada", threadIds: ["octopus"] } };
    let tree: ReactNode;
    function Capture() { tree = ThreadChip({ message: line }); return tree; }
    expect(renderToStaticMarkup(createElement(Capture))).toContain("Ada asked me: Octopus facts");
    expect((findType(tree, BotAvatar)!.props.bot as Bot).id).toBe("ada");
    findElement(tree, "data-thread-chip")!.props.onClick!();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "switchTask", botId: "scout", threadId: "octopus" },
      { type: "revealThread", threadId: "octopus" },
    ]);
  });

  it("keeps the thread's own bot on every other chip", () => {
    let tree: ReactNode;
    function Capture() { tree = ThreadChip({ message: receipt() }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    expect((findType(tree, BotAvatar)!.props.bot as Bot).id).toBe("scout");
  });

  it("renders the receipt as a pill named for the thread it opens", () => {
    const markup = renderToStaticMarkup(createElement(ThreadChip, { message: receipt() }));
    expect(markup).toContain("<button");
    expect(markup).toContain("Opened thread #QA PR 245 on Scout");
    expect(markup).toContain('title="Open #QA PR 245"');
    expect(markup).toContain('data-thread-chip="qa-245"');
  });

  it("says in the person's words that work addressed into a room went to a bot outside it directly", () => {
    const sent = (sentDirectly: Message["sentDirectly"]) => renderToStaticMarkup(createElement(ThreadChip, {
      message: { ...receipt(), tool: { name: "server English", ok: true }, sentDirectly },
    }));
    expect(sent({ name: "Scout" })).toContain("Sent to Scout directly: it isn&#x27;t in this room.");
    expect(sent({ name: "Scout", room: "Sales" })).toContain("Sent to Scout directly: it isn&#x27;t in Sales.");
    expect(sent({ name: "Scout" })).not.toContain("server English");
  });

  it("renders nothing without a thread reference", () => {
    expect(renderToStaticMarkup(createElement(ThreadChip, { message: { ...receipt(), threadRef: undefined } }))).toBe("");
  });

  it("clicking shows that thread: select the bot, switch the view, reveal the row", () => {
    let tree: ReactNode;
    function Capture() { tree = ThreadChip({ message: receipt() }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-thread-chip")!.props.onClick!();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "switchTask", botId: "scout", threadId: "qa-245" },
      { type: "revealThread", threadId: "qa-245" },
    ]);
  });

  it("with threads hidden, the switch alone shows it, so the thread the bot was on stays unread", () => {
    fixture.showThreads = false;
    let tree: ReactNode;
    function Capture() { tree = ThreadChip({ message: receipt() }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-thread-chip")!.props.onClick!();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "qa-245" },
      { type: "revealThread", threadId: "qa-245" },
    ]);
  });

  it("falls back to the bot with a notice when the thread was deleted", () => {
    let tree: ReactNode;
    function Capture() { tree = ThreadChip({ message: receipt("gone") }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-thread-chip")!.props.onClick!();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "gone" },
      { type: "notice", notice: { kind: "thread-gone", botName: "Scout" } },
    ]);
  });

  it("marks the receipt when the work in that thread failed", () => {
    const failed = renderToStaticMarkup(createElement(ThreadChip, {
      message: { ...receipt(), tool: { name: "Scout — cancelled: stopped by the person", ok: false } },
    }));
    expect(failed).toContain("Scout — cancelled: stopped by the person");
    expect(failed).toMatch(/<button[^>]*class="[^"]*text-danger/);
    expect(renderToStaticMarkup(createElement(ThreadChip, { message: receipt() }))).not.toContain("text-danger");
  });
});
