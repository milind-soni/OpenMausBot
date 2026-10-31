import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { Answerer } from "../runtime/types.ts";
import type { BotRecord, Message } from "../store.ts";
import { createQuestionRouting, type QuestionRoutingDeps } from "./question-routing.ts";

const bot = (id: string, name: string, extra: Partial<BotRecord> = {}) => ({ id, name, color: "teal", ...extra }) as BotRecord;
const FUCHS = bot("fuchs", "Fuchs", { chiefOfStaff: true });
const DACHS = bot("dachs", "Dachs");
const OTTER = bot("otter", "Otter");

function world(options: { live?: string[]; privateTo?: string } = {}) {
  const threads = new Map<string, Message[]>();
  let ids = 0;
  const rows = (threadId: string) => threads.get(threadId) ?? [];
  const tasks: Record<string, Array<{ threadId: string; title: string }>> = { dachs: [{ threadId: "work", title: "Fix" }, { threadId: "other-work", title: "Other" }] };
  const store = {
    bot: (id: string) => [FUCHS, DACHS, OTTER].find((one) => one.id === id),
    tasks: (botId: string) => tasks[botId] ?? [],
    taskByThread: (botId: string, threadId: string) => (tasks[botId] ?? []).find((task) => task.threadId === threadId),
    messagesFor: rows,
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: 1_000 + ids, ...message } as Message;
      threads.set(threadId, [...rows(threadId), full]);
      return full;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
      const list = rows(threadId);
      const at = list.findIndex((message) => message.id === id);
      list[at] = { ...list[at]!, ...patch };
      return list[at]!;
    },
  };
  const nodes = new Map<string, HandoffView>();
  const node = (over: Partial<HandoffView>): HandoffView => {
    const made = { id: "as_1", rootId: "root", parentId: "root", threadId: "work", botId: "dachs", key: "dachs", text: "Fix it", createdAt: 1_000,
      status: "waiting", result: "", reported: false, executions: 1, approvalGranted: false, kind: "work", restarts: 0, mode: "work", reply: "resume", ...over } as HandoffView;
    nodes.set(made.id, made);
    return made;
  };
  nodes.set("root", { id: "root", rootId: "root", threadId: "inbox", botId: "fuchs", status: "waiting" } as HandoffView);
  const answeredNodes: Array<{ id: string; text: string; by: Answerer }> = [];
  const answeredLive: Array<{ threadId: string; requestId: string; text: string }> = [];
  const settled: string[] = [];
  const deps: QuestionRoutingDeps = {
    store: store as unknown as QuestionRoutingDeps["store"],
    active: () => [...nodes.values()],
    node: (id) => nodes.get(id),
    parkedFor: (botId) => [...nodes.values()].filter((one) => one.botId === botId && one.status === "waiting" && one.question !== undefined),
    answerNode: (id, text, by) => {
      const parked = nodes.get(id);
      if (!parked || parked.status !== "waiting") return false;
      answeredNodes.push({ id, text, by });
      nodes.set(id, { ...parked, status: "queued", question: undefined });
      return true;
    },
    live: (_threadId, requestId) => (options.live ?? []).includes(requestId),
    answerLive: async (threadId, requestId, text) => { answeredLive.push({ threadId, requestId, text }); return true; },
    settleSignIns: (parked) => { settled.push(parked.id); },
    keptPrivate: (child, requester) => child.threadId === options.privateTo && requester.threadId !== options.privateTo,
  };
  return { routing: createQuestionRouting(deps), store, rows, node, nodes, answeredNodes, answeredLive, settled };
}

describe("at Full access a question asked with an ask tool", () => {
  it("is not asked in work the person started and a bot handed on: the bot takes its default or hands the choice to its requester", () => {
    const w = world();
    w.node({ status: "running", origin: { kind: "user", request: "Export the report" } });
    expect(w.routing.notAsked({ botId: "dachs", threadId: "work", level: "full", question: "CSV or Excel?" }))
      .toBe("Not asked: at this level nobody is interrupted. Take the sensible default yourself, carry on, and say in one plain line what you chose. "
        + "If you truly cannot choose, end your turn with NEEDS INPUT:, the question and Default: your pick, and @Fuchs decides.");
  });

  it("still reaches the person when only they can give it, below Full access, in their own chat, in work an outside event started, and in work in their private chat", () => {
    const w = world();
    w.node({ status: "running" });
    expect(w.routing.notAsked({ botId: "dachs", threadId: "work", level: "full", question: "Please sign in to the bank portal" })).toBeUndefined();
    expect(w.routing.notAsked({ botId: "dachs", threadId: "work", level: "full", question: "Soll ich die Rechnung bezahlen?" })).toBeUndefined();
    expect(w.routing.notAsked({ botId: "dachs", threadId: "work", level: "ask", question: "CSV or Excel?" })).toBeUndefined();
    expect(w.routing.notAsked({ botId: "dachs", threadId: "chat", level: "full", question: "CSV or Excel?" })).toBeUndefined();
    const hooked = world();
    hooked.node({ status: "running", origin: { kind: "outside" } });
    expect(hooked.routing.notAsked({ botId: "dachs", threadId: "work", level: "full", question: "CSV or Excel?" })).toBeUndefined();
    const theirs = world({ privateTo: "work" });
    theirs.node({ status: "running", origin: { kind: "user", request: "Sort my inbox" } });
    expect(theirs.routing.notAsked({ botId: "dachs", threadId: "work", level: "full", question: "CSV or Excel?" })).toBeUndefined();
  });
});

describe("an answer passed on by another bot", () => {
  const parked = (w: ReturnType<typeof world>, over: Partial<HandoffView> = {}) => {
    const node = w.node({ question: "Welche Formulierung?", ...over });
    w.store.appendMessage(node.threadId, { role: "bot", kind: "options", text: "Welche Formulierung?", card: { title: "Your bot has a question", subtitle: "Welche Formulierung?", options: [], requestId: `needs-input-${node.id}-1`, requestType: "question" } });
    return node;
  };

  it("answers the question it names, from any conversation, and the card says which bot answered", async () => {
    const w = world();
    const node = parked(w);
    const receipt = await w.routing.relay({ sender: FUCHS, senderThreadId: "inbox", target: DACHS, message: "Marco sagt: kurz und freundlich", answers: node.id });
    expect(receipt).toMatchObject({ botId: "dachs", outcome: "injected", threadId: "work", requestId: node.id });
    expect(receipt?.detail).toContain('answered its question "Welche Formulierung?"');
    expect(w.answeredNodes).toEqual([{ id: node.id, text: "Marco sagt: kurz und freundlich", by: { kind: "bot", botId: "fuchs" } }]);
    expect(w.rows("work")[0]!.card).toMatchObject({ answered: "answer", answeredText: "Marco sagt: kurz und freundlich", answeredBy: { kind: "bot", name: "Fuchs" } });
    expect(w.rows("inbox").map((row) => row.tool?.name)).toEqual(["Answered Dachs's question"]);
  });

  it("answers the question the sender's own turn was resumed with, without naming it", async () => {
    const w = world();
    const node = parked(w);
    const turn = { id: "root", carrying: [node.id] } as HandoffView;
    expect(await w.routing.relay({ sender: FUCHS, senderThreadId: "inbox", senderNode: turn, target: DACHS, message: "Excel" })).toMatchObject({ outcome: "injected" });
    expect(w.answeredNodes.map((one) => one.text)).toEqual(["Excel"]);
  });

  it("never takes new work for an answer: same conversation, same sender, a question still open", async () => {
    const w = world();
    parked(w);
    expect(await w.routing.relay({ sender: FUCHS, senderThreadId: "inbox", senderNode: { id: "root" } as HandoffView, target: DACHS, message: "Neue Aufgabe: prüf das Logo" })).toBeUndefined();
    expect(w.answeredNodes).toEqual([]);
    expect(w.rows("work")[0]!.card!.answered).toBeUndefined();
  });

  it("refuses an answer to work that no longer asks, saying how to send it as work instead", async () => {
    const w = world();
    const receipt = await w.routing.relay({ sender: FUCHS, senderThreadId: "inbox", target: DACHS, message: "kurz", answers: "as_gone" });
    expect(receipt).toMatchObject({ outcome: "failed" });
    expect(receipt?.detail).toBe("nothing of Dachs's waits on an answer as as_gone: it was answered or its work ended. Send it without answers if it still needs doing");
  });

  it("answers the question card a teammate's turn waits on, saying which bot answered, and settles a sign-in only wait", async () => {
    const w = world({ live: ["req-1"] });
    w.node({ id: "as_live", status: "running" });
    w.store.appendMessage("work", { role: "bot", kind: "options", text: "Soll ich?", card: { title: "Your bot has a question", subtitle: "Soll ich?", options: ["Ja", "Nein"], requestId: "req-1", requestType: "question" } });
    expect(await w.routing.relay({ sender: FUCHS, senderThreadId: "inbox", target: DACHS, message: "Ja", answers: "as_live" })).toMatchObject({ outcome: "injected" });
    expect(w.answeredLive).toEqual([{ threadId: "work", requestId: "req-1", text: "@Fuchs answered: Ja" }]);
    expect(w.rows("work")[0]!.card).toMatchObject({ answered: "answer", answeredText: "Ja", answeredBy: { kind: "bot", name: "Fuchs" } });

    const signIn = world();
    signIn.store.appendMessage("work", { role: "bot", kind: "signin", text: "Sign in", signIn: { url: "https://notion.so", site: "notion.so", place: "browser" } });
    const node = signIn.node({ question: "Waiting on the person: sign in to notion.so", cards: ["m1"] });
    expect(await signIn.routing.relay({ sender: FUCHS, senderThreadId: "inbox", target: DACHS, message: "Marco ist angemeldet", answers: node.id })).toMatchObject({ outcome: "injected" });
    expect(signIn.settled).toEqual([node.id]);
  });

  it("does not answer work that waits on a card no bot can settle", async () => {
    const connect = world();
    connect.store.appendMessage("work", { role: "bot", kind: "connector", text: "Connect" });
    const node = connect.node({ question: "Waiting on the person: connect Notion", cards: ["m1"] });
    expect(await connect.routing.relay({ sender: FUCHS, senderThreadId: "inbox", target: DACHS, message: "verbunden", answers: node.id })).toMatchObject({ outcome: "failed" });
    expect(connect.answeredNodes).toEqual([]);
  });
});
