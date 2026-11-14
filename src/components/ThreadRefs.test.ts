import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), selectedId: "scout", showThreads: true }));
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
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
import { ThreadLink, ThreadRefText, ThreadRefsProvider, collectThreadRefs, openChatLink, threadLinkFromProps, useThreadRefs } from "./ThreadRefs";

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

beforeEach(() => { fixture.dispatch.mockClear(); fixture.selectedId = "scout"; fixture.showThreads = true; });

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
    expect(guessed).toContain('data-thread-link="ada-qa"');
    expect(guessed).toContain('title="Open #QA PR 245"');
  });

  it("renders plain text untouched when nothing matches", () => {
    expect(inProvider(createElement(ThreadRefText, { text: "see #123 and #Unknown" }))).toBe("see #123 and #Unknown");
  });

  it("links a room thread too", () => {
    expect(inProvider(createElement(ThreadRefText, { text: "on #Monday plan" }))).toContain('data-thread-link="standup-1"');
  });

  it("renders a sent canonical link as a chip labeled with the title", () => {
    const markup = inProvider(createElement(ThreadRefText, {
      text: "done in [QA PR 245](openmausbot://thread/qa-245?bot=scout) today",
    }));
    expect(markup).toContain("done in ");
    expect(markup).toContain('<button type="button" data-thread-link="qa-245"');
    expect(markup).toContain(">QA PR 245</button>");
    expect(markup).toContain(" today");
  });

  it("keeps a dead thread link as the raw text it was sent as", () => {
    expect(inProvider(createElement(ThreadRefText, { text: "see [Gone](openmausbot://thread/dead?bot=scout)" })))
      .toBe("see [Gone](openmausbot://thread/dead?bot=scout)");
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
    fixture.showThreads = false;
    fixture.dispatch.mockClear();
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-thread-link")!.props.onClick!();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
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

describe("openChatLink", () => {
  const state = async () => ({ ...(await import("@/state/store")).initialState, bots: [scout, ada], groups: [room, dm], selectedId: "ada" });
  const actions = (dispatch: ReturnType<typeof vi.fn>) => dispatch.mock.calls.map(([action]) => action);

  it("opens the chat a copied link names, and nothing else", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://thread/qa-245?bot=scout", await state(), true)).toBe(true);
    expect(actions(dispatch)).toEqual([
      { type: "select", id: "scout" },
      { type: "switchTask", botId: "scout", threadId: "qa-245" },
      { type: "revealThread", threadId: "qa-245" },
    ]);
  });

  it("opens a room's thread too", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://thread/standup-1?bot=standup", await state(), true)).toBe(true);
    expect(actions(dispatch)).toContainEqual({ type: "revealThread", threadId: "standup-1" });
  });

  it("opens a bot-only link at its current conversation, switching nothing", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://bot/scout", await state(), true)).toBe(true);
    expect(actions(dispatch)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("opens a room by its id, never a bot-to-bot channel", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://bot/standup", await state(), true)).toBe(true);
    expect(actions(dispatch)).toEqual([
      { type: "select", id: "standup" },
      { type: "revealThread", threadId: "standup-1" },
    ]);
    const refused = vi.fn();
    expect(openChatLink(refused, "openmausbot://bot/dm", await state(), true)).toBe(false);
    expect(actions(refused)).toEqual([{ type: "notice", notice: { kind: "bot-gone", botName: null } }]);
  });

  it("refuses a thread that is not the named bot's, showing that bot instead", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://thread/qa-245?bot=ada", await state(), true)).toBe(false);
    expect(actions(dispatch)).toEqual([
      { type: "select", id: "ada" },
      { type: "notice", notice: { kind: "thread-gone", botName: "Ada" } },
    ]);
  });

  it("refuses a room's dead thread, showing that room instead", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://thread/gone?bot=standup", await state(), true)).toBe(false);
    expect(actions(dispatch)).toEqual([
      { type: "select", id: "standup" },
      { type: "notice", notice: { kind: "thread-gone", botName: "Standup" } },
    ]);
  });

  it("says a bot it does not know is gone", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://bot/nobody", await state(), true)).toBe(false);
    expect(actions(dispatch)).toEqual([{ type: "notice", notice: { kind: "bot-gone", botName: null } }]);
  });

  it("says so for a chat or link it does not know, and changes nothing", async () => {
    for (const link of [
      "openmausbot://thread/missing?bot=nobody",
      "openmausbot://thread/qa-245/extra",
      "openmausbot://bot/scout/extra",
      "openmausbot://bots/scout",
      "not a link",
    ]) {
      const dispatch = vi.fn();
      expect(openChatLink(dispatch, link, await state(), true)).toBe(false);
      expect(actions(dispatch)).toEqual([{ type: "notice", notice: { kind: "thread-gone", botName: null } }]);
    }
  });

  it("returns from the team map to the open chat, where the notice shows", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://bot/nobody", { ...await state(), activeView: "team-map" }, true)).toBe(false);
    expect(actions(dispatch)).toEqual([
      { type: "select", id: "ada" },
      { type: "notice", notice: { kind: "bot-gone", botName: null } },
    ]);
  });

  it("opens a bot-only link at the bot's main thread while threads are hidden, as its row would", async () => {
    const left = { ...(await state()), bots: [{ ...scout, threadId: "qa-245", mainThreadId: "scout-main" }, ada] };
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://bot/scout", left, false)).toBe(true);
    expect(actions(dispatch)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "scout-main" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
    const dead = vi.fn();
    expect(openChatLink(dead, "openmausbot://thread/gone?bot=scout", left, false)).toBe(false);
    expect(actions(dead)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "scout-main" },
      { type: "notice", notice: { kind: "thread-gone", botName: "Scout" } },
    ]);
    const shown = vi.fn();
    expect(openChatLink(shown, "openmausbot://bot/scout", left, true)).toBe(true);
    expect(actions(shown)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "qa-245" },
    ]);
  });

  it("opens a copied thread link by the switch alone while threads are hidden", async () => {
    const dispatch = vi.fn();
    expect(openChatLink(dispatch, "openmausbot://thread/qa-245?bot=scout", await state(), false)).toBe(true);
    expect(actions(dispatch)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "qa-245" },
      { type: "revealThread", threadId: "qa-245" },
    ]);
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
