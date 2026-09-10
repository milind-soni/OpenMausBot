import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), selectedId: "scout" }));
const bot = (id: string, name: string, tasks: Bot["tasks"]): Bot => ({
  id, threadId: tasks?.[0]?.threadId ?? id, name, title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" }, tasks,
});
const scout = bot("scout", "Scout", [
  { threadId: "scout-main", title: "Main", createdAt: 1 },
  { threadId: "qa-245", title: "QA PR 245", createdAt: 2 },
]);
const ada = bot("ada", "Ada", [{ threadId: "ada-qa", title: "QA PR 245", createdAt: 3 }]);
const room: Group = {
  id: "standup", threadId: "standup-1", name: "Standup", memberIds: ["scout"], defaultResponder: { kind: "everyone" },
  bulletin: "", unread: false, createdAt: 1, messages: [], tasks: [{ threadId: "standup-1", title: "Monday plan", createdAt: 4 }],
};
const dm: Group = { ...room, id: "dm", threadId: "dm-1", name: "Scout ⇄ Ada", dm: true, tasks: [{ threadId: "dm-1", title: "Private", createdAt: 5 }] };

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [scout, ada], groups: [room, dm], selectedId: fixture.selectedId },
    dispatch: fixture.dispatch,
  }) };
});
import { ThreadLink, ThreadRefText, ThreadRefsProvider, collectThreadRefs, threadLinkFromProps, useThreadRefs } from "./ThreadRefs";

type ElementProps = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (attribute in child.props) return child;
    const found = findElement(child.props.children, attribute);
    if (found) return found;
  }
}
const inProvider = (child: ReactNode) => renderToStaticMarkup(createElement(ThreadRefsProvider, null, child));

beforeEach(() => { fixture.dispatch.mockClear(); fixture.selectedId = "scout"; });

describe("collectThreadRefs", () => {
  it("lists every bot thread in store order, then room threads, never a bot-to-bot channel", () => {
    expect(collectThreadRefs([scout, ada], [room, dm]).map((ref) => `${ref.botName}:${ref.title}`)).toEqual([
      "Scout:Main", "Scout:QA PR 245", "Ada:QA PR 245", "Standup:Monday plan",
    ]);
  });
});

describe("ThreadRefText", () => {
  it("links a #Title the person typed and leaves the rest as text", () => {
    const markup = inProvider(createElement(ThreadRefText, { text: "please finish #QA PR 245 first" }));
    expect(markup).toContain("please finish ");
    expect(markup).toContain('<button type="button" data-thread-link="qa-245"');
    expect(markup).toContain('title="Open #QA PR 245"');
    expect(markup).toContain(">#QA PR 245</button>");
  });

  it("prefers the open bot's thread over a teammate's with the same title, and names the bot when it had to guess", () => {
    expect(inProvider(createElement(ThreadRefText, { text: "#QA PR 245" }))).toContain('data-thread-link="qa-245"');
    fixture.selectedId = "ada";
    expect(inProvider(createElement(ThreadRefText, { text: "#QA PR 245" }))).toContain('data-thread-link="ada-qa"');
    fixture.selectedId = "standup";
    const guessed = inProvider(createElement(ThreadRefText, { text: "#QA PR 245" }));
    // newest by activity wins outright here, so no tooltip guess is needed
    expect(guessed).toContain('data-thread-link="ada-qa"');
    expect(guessed).toContain('title="Open #QA PR 245"');
  });

  it("renders plain text untouched when nothing matches", () => {
    expect(inProvider(createElement(ThreadRefText, { text: "see #123 and #Unknown" }))).toBe("see #123 and #Unknown");
  });

  it("links a room thread too", () => {
    expect(inProvider(createElement(ThreadRefText, { text: "on #Monday plan" }))).toContain('data-thread-link="standup-1"');
  });
});

describe("ThreadLink", () => {
  it("clicking opens that thread through openThread", () => {
    let tree: ReactNode;
    function Capture() {
      tree = ThreadLink({ target: { botId: "scout", threadId: "qa-245", title: "QA PR 245", botName: "Scout" }, ambiguous: false, children: "#QA PR 245" });
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-thread-link")!.props.onClick!();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "switchTask", botId: "scout", threadId: "qa-245" },
      { type: "revealThread", threadId: "qa-245" },
    ]);
  });

  it("names the bot in the tooltip only when the title was ambiguous", () => {
    const target = { botId: "ada", threadId: "ada-qa", title: "QA PR 245", botName: "Ada" };
    expect(renderToStaticMarkup(createElement(ThreadLink, { target, ambiguous: true }, "#QA PR 245"))).toContain('title="Open #QA PR 245 on Ada"');
    expect(renderToStaticMarkup(createElement(ThreadLink, { target, ambiguous: false }, "#QA PR 245"))).toContain('title="Open #QA PR 245"');
  });

  it("reads a thread link back out of the markdown span props, and nothing out of a plain span", () => {
    expect(threadLinkFromProps({ "data-thread-id": "qa-245", "data-thread-bot": "scout", "data-thread-title": "QA PR 245", "data-thread-bot-name": "Scout", "data-thread-ambiguous": "true" }))
      .toEqual({ target: { threadId: "qa-245", botId: "scout", title: "QA PR 245", botName: "Scout" }, ambiguous: true });
    expect(threadLinkFromProps({ children: "x" })).toBeNull();
  });
});

describe("ThreadRefsProvider", () => {
  it("publishes the visible threads and the open bot to consumers", () => {
    function Probe() {
      const { threads, currentBotId } = useThreadRefs();
      return createElement("i", null, `${currentBotId}:${threads.map((ref) => ref.threadId).join(",")}`);
    }
    expect(inProvider(createElement(Probe))).toBe("<i>scout:scout-main,qa-245,ada-qa,standup-1</i>");
  });
});


// Merged with #900: a line can carry an @mention and a #thread at once, and
// each decoration comes from its own resolver without disturbing the other.
describe("ThreadRefText with mention peers", () => {
  it("highlights the @mention and links the #thread in one line", () => {
    const markup = inProvider(createElement(ThreadRefText, {
      text: "@Scout please look at #QA PR 245 today",
      peers: [{ name: "Scout", color: "green" }],
    }));
    expect(markup).toContain('class="mention-highlight"');
    expect(markup).toContain("@Scout");
    expect(markup).toContain('data-thread-link="qa-245"');
    expect(markup).toContain(">#QA PR 245</button>");
    expect(markup).toContain(" today");
  });
});
