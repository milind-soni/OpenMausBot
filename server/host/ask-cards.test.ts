import { describe, expect, it, vi } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { Notification } from "../notify.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message } from "../store.ts";
import { askToolName, createAskCards, type AskCardsDeps } from "./ask-cards.ts";

const AUTH = { kind: "session", scopes: ["client"], session: { id: "s", email: "cleo@acme.test" } } as unknown as RequestAuth;
const QUESTION = "What wording should the new footer text use?";

function world(options: { inboxThread?: string; live?: string[] } = {}) {
  const threads = new Map<string, Message[]>();
  let ids = 0;
  const bots = [
    { id: "scout", name: "Scout", color: "orange", tasks: [{ threadId: "inbox", title: "Inbox" }] },
    { id: "ledger", name: "Ledger", color: "teal", tasks: [{ threadId: "work", title: "Pricing page: fix" }] },
  ] as unknown as BotRecord[];
  const rows = (threadId: string) => threads.get(threadId) ?? [];
  const store = {
    bot: (id: string) => bots.find((bot) => bot.id === id),
    messagesFor: rows,
    activePath: rows,
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
    taskByThread: (botId: string, threadId: string) => (bots.find((bot) => bot.id === botId)?.tasks ?? []).find((task) => task.threadId === threadId),
    patchTask: () => null,
    group: () => undefined,
    groupTaskByThread: () => undefined,
    patchGroup: () => null,
    groupByThread: (threadId: string) => (threadId === "room" ? { id: "room" } : undefined),
  };
  const nodes = new Map<string, HandoffView>();
  const notified: Notification[] = [];
  const answers: Array<{ threadId: string; requestId: string; message: string }> = [];
  let refuse: { status: number; error: string } | null = null;
  const deps: AskCardsDeps = {
    store: store as unknown as AskCardsDeps["store"],
    node: (id) => nodes.get(id),
    delegatorOf: (threadId) => (threadId === "work" ? { threadId: "inbox", botId: "scout" } : undefined),
    notify: (notification) => { if (notification) notified.push(notification); },
    copiedInto: (inboxThreadId) => inboxThreadId === options.inboxThread,
    live: (_threadId, requestId) => (options.live ?? []).includes(requestId),
    answerCard: vi.fn(async (input) => {
      if (refuse) return { ok: false as const, ...refuse };
      answers.push({ threadId: input.threadId, requestId: input.requestId, message: input.message });
      return { ok: true as const };
    }),
    answeredIn: (threadId, requestId) => (threadId === "inbox" && requestId.startsWith("req") ? "work" : threadId),
  };
  const cards = createAskCards(deps);
  const node = (over: Partial<HandoffView> = {}): HandoffView => {
    const made = { id: "as_1", rootId: "root", parentId: "root", threadId: "work", botId: "ledger", key: "ledger", text: "Fix it", createdAt: 1_000,
      startedAt: 1_000, status: "waiting", result: "", reported: false, executions: 1, lastProgressAt: 1_000, approvalGranted: false, kind: "work",
      restarts: 0, mode: "work", reply: "resume", ...over } as HandoffView;
    nodes.set(made.id, made);
    return made;
  };
  nodes.set("root", { id: "root", rootId: "root", threadId: "inbox", botId: "scout" } as HandoffView);
  const say = (threadId: string, text: string) => store.appendMessage(threadId, { role: "bot", kind: "text", text });
  return { cards, store, rows, notified, answers, node, say, deps, refuse: (value: typeof refuse) => { refuse = value; } };
}

describe("a teammate's NEEDS INPUT question", () => {
  it("becomes a question card in its conversation, its line keeps the words before it, and the requester's chat gets one chip", () => {
    const w = world();
    w.say("work", `The footer text still uses the old template.\nNEEDS INPUT: ${QUESTION}`);
    w.cards.park(w.node(), QUESTION);
    const [line, card] = w.rows("work");
    expect(line).toMatchObject({ kind: "text", text: "The footer text still uses the old template." });
    expect(card).toMatchObject({ role: "bot", kind: "options", text: QUESTION,
      card: { subtitle: QUESTION, options: [], requestId: "needs-input-as_1-1", requestType: "question" } });
    expect(w.rows("inbox").map((row) => row.tool?.name)).toEqual([`Ledger needs your input: ${QUESTION}`]);
    expect(w.notified.map((notification) => [notification.kind, notification.threadId])).toEqual([["question", "work"]]);
  });

  it("turns a reply that is only the question into the card itself", () => {
    const w = world();
    w.say("work", `NEEDS INPUT: ${QUESTION}`);
    w.cards.park(w.node(), QUESTION);
    expect(w.rows("work")).toHaveLength(1);
    expect(w.rows("work")[0]).toMatchObject({ kind: "options", text: QUESTION, card: { requestId: "needs-input-as_1-1" } });
  });

  it("leaves the person's inbox to the card's copy: no chip there", () => {
    const w = world({ inboxThread: "inbox" });
    w.say("work", `Checked.\nNEEDS INPUT: ${QUESTION}`);
    w.cards.park(w.node(), QUESTION);
    expect(w.rows("inbox")).toEqual([]);
    expect(w.notified.map((notification) => notification.kind)).toEqual(["question"]);
  });

  it("shows it once across a restart, and still once when the restart came before the first showing", () => {
    const w = world();
    w.say("work", `Checked.\nNEEDS INPUT: ${QUESTION}`);
    const parked = w.node();
    w.cards.park(parked, QUESTION);
    w.cards.park(parked, QUESTION, true);
    expect(w.rows("work").filter((row) => row.card)).toHaveLength(1);
    expect(w.rows("inbox")).toHaveLength(1);
    expect(w.notified).toHaveLength(1);

    const fresh = world();
    fresh.say("work", `Checked.\nNEEDS INPUT: ${QUESTION}`);
    fresh.cards.park(fresh.node(), QUESTION, true);
    expect(fresh.rows("work").filter((row) => row.card)).toHaveLength(1);
    expect(fresh.notified).toHaveLength(1);
  });

  it("asks again with a new card after an answer, on the node's next execution", () => {
    const w = world();
    w.say("work", `NEEDS INPUT: ${QUESTION}`);
    w.cards.park(w.node(), QUESTION);
    w.cards.answeredInWords("work", "Short and friendly");
    w.say("work", "NEEDS INPUT: With a logo?");
    w.cards.park(w.node({ executions: 2 }), "With a logo?");
    expect(w.rows("work").map((row) => row.card?.requestId)).toEqual(["needs-input-as_1-1", "needs-input-as_1-2"]);
  });

  it("keeps a room member's question and a parked card's wait as they were: a chip and the work's notice, no card", () => {
    const room = world();
    room.say("work", `NEEDS INPUT: ${QUESTION}`);
    room.cards.park(room.node({ groupId: "room" }), QUESTION);
    expect(room.rows("work").some((row) => row.card)).toBe(false);
    expect(room.notified.map((notification) => notification.kind)).toEqual(["delegation-settled"]);

    const card = world({ inboxThread: "inbox" });
    card.cards.park(card.node({ cards: ["m9"] }), "Waiting on the person: connect Gmail");
    expect(card.rows("inbox").map((row) => row.tool?.name)).toEqual(["Ledger needs your input: Waiting on the person: connect Gmail"]);
    expect(card.notified.map((notification) => notification.kind)).toEqual(["delegation-settled"]);
  });
});

describe("how an open question card settles", () => {
  const parked = () => {
    const w = world();
    w.say("work", `Checked.\nNEEDS INPUT: ${QUESTION}`);
    const node = w.node();
    w.cards.park(node, QUESTION);
    const card = () => w.rows("work").find((row) => row.card)!.card!;
    return { w, node, card };
  };

  it("takes the person's own words as the answer", () => {
    const { w, card } = parked();
    w.cards.answeredInWords("work", "Short and friendly");
    expect(card()).toMatchObject({ answered: "answer", answeredText: "Short and friendly" });
  });

  it("says Stop ended it, or that the wait ran out, and leaves an answered or finished one alone", () => {
    const stopped = parked();
    stopped.w.cards.closed({ ...stopped.node, status: "cancelled", outcome: "stopped" });
    expect(stopped.card()).toMatchObject({ answered: "unavailable", dismissed: true, stopped: true });

    const expired = parked();
    expired.w.cards.closed({ ...expired.node, status: "failed", outcome: "expired" });
    expect(expired.card()).toMatchObject({ expired: true });
    expect(expired.card().answered).toBeUndefined();

    const failed = parked();
    failed.w.cards.closed({ ...failed.node, status: "failed", outcome: "refused" });
    expect(failed.card()).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(failed.card().stopped).toBeUndefined();

    const done = parked();
    done.w.cards.answeredInWords("work", "Yes");
    done.w.cards.closed({ ...done.node, status: "cancelled", outcome: "stopped" });
    expect(done.card()).toMatchObject({ answered: "answer", answeredText: "Yes" });
    const finished = parked();
    finished.w.cards.closed({ ...finished.node, status: "completed", outcome: "done" });
    expect(finished.card().answered).toBeUndefined();
  });
});

describe("a typed line answers a question card", () => {
  const question = (w: ReturnType<typeof world>, threadId: string, card: Partial<NonNullable<Message["card"]>> = {}) =>
    w.store.appendMessage(threadId, { role: "bot", kind: "options", text: "Should I?", card: { title: "Your bot has a question", subtitle: "Should I?",
      options: ["Yes, only the footer text", "No"], requestId: "req-1", requestType: "question", ...card } });

  it("answers the card the bot's turn waits on in its conversation, and keeps the person's line under it", async () => {
    const w = world({ live: ["req-1"] });
    const asked = question(w, "work");
    const result = await w.cards.typed(AUTH, "work", "Just the footer text, please", undefined, { sendId: "send-1" });
    expect(w.answers).toEqual([{ threadId: "work", requestId: "req-1", message: "Just the footer text, please" }]);
    expect(result).toMatchObject({ status: 202, message: { role: "user", text: "Just the footer text, please", replyToId: asked.id, sendId: "send-1" } });
    const again = await w.cards.typed(AUTH, "work", "Just the footer text, please", undefined, { sendId: "send-1" });
    expect(again?.message?.id).toBe(result?.message?.id);
    expect(w.answers).toHaveLength(1);
  });

  it("files the words under a structured question's own text", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "work", { questionRequest: { version: 1, questions: [{ question: "Should I?", options: [{ label: "Yes" }, { label: "No" }] }] } });
    await w.cards.typed(AUTH, "work", "Not until tomorrow", undefined, {});
    expect(w.answers[0]!.message).toBe("The user answered your questions.\n\nQ: Should I?\nA: Not until tomorrow");
  });

  it("answers the original through the copy a reply in the inbox is to, whether or not its turn still waits", async () => {
    const w = world();
    const copy = question(w, "inbox");
    const result = await w.cards.typed(AUTH, "inbox", "Yes, only the footer text", copy, { sendId: "send-2" });
    expect(w.answers).toEqual([{ threadId: "inbox", requestId: "req-1", message: "Yes, only the footer text" }]);
    expect(result?.message).toMatchObject({ role: "user", replyToId: copy.id, sendId: "send-2" });
  });

  it("leaves everything else to the usual send: no live card, a reply to another line, Stop, a room, a card that takes only its options", async () => {
    const idle = world();
    const asked = question(idle, "work");
    expect(await idle.cards.typed(AUTH, "work", "Yes", undefined, {})).toBeNull();
    expect(await idle.cards.typed(AUTH, "work", "Yes", asked, {})).toBeNull();
    const busy = world({ live: ["req-1"] });
    question(busy, "work");
    const other = busy.say("work", "I checked.");
    expect(await busy.cards.typed(AUTH, "work", "Thanks", other, {})).toBeNull();
    expect(await busy.cards.typed(AUTH, "work", "stop", undefined, {})).toBeNull();
    expect(await busy.cards.typed(AUTH, "room", "Yes", undefined, {})).toBeNull();
    const fixed = world({ live: ["req-1"] });
    question(fixed, "work", { fixedOptions: true });
    expect(await fixed.cards.typed(AUTH, "work", "Yes", undefined, {})).toBeNull();
    expect(idle.answers).toEqual([]);
    expect(busy.answers).toEqual([]);
    expect(fixed.answers).toEqual([]);
  });

  it("leaves a line in a chat no teammate handed on to be steered or queued, even while its question card waits", async () => {
    const w = world({ live: ["req-1"] });
    const asked = question(w, "chat");
    expect(await w.cards.typed(AUTH, "chat", "Take the second one", undefined, {})).toBeNull();
    expect(await w.cards.typed(AUTH, "chat", "Take the second one", asked, {})).toBeNull();
    expect(w.answers).toEqual([]);
  });

  it("passes on why an answer was refused, and writes no line", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "work");
    w.refuse({ status: 403, error: "This question is Ben's to answer." });
    expect(await w.cards.typed(AUTH, "work", "Yes", undefined, {})).toEqual({ status: 403, error: "This question is Ben's to answer." });
    expect(w.rows("work").filter((row) => row.role === "user")).toEqual([]);
  });
});

describe("the chip in the conversation that handed the work on", () => {
  const asker = { id: "ledger", name: "Ledger", color: "teal" } as BotRecord;

  it("says the work waits on the person, unless that conversation is the person's inbox, which has the card", () => {
    const desk = world();
    desk.cards.showWaitingOnPersonChip("work", "req-1", asker, "answer");
    expect(desk.rows("inbox").map((row) => row.tool?.name)).toEqual(["Waiting on your answer in @Ledger"]);
    const team = world({ inboxThread: "inbox" });
    team.cards.showWaitingOnPersonChip("work", "req-1", asker, "answer");
    expect(team.rows("inbox")).toEqual([]);
  });
});

describe("askToolName", () => {
  const bot = (toolScope?: BotRecord["toolScope"]) => ({ modelSelection: { instanceId: "claude", model: "m" }, toolScope }) as BotRecord;
  const claude = () => ({ kind: "mcp" as const, server: "ogb", name: "ask_user" });

  it("names the engine's question tool unless the bot's tool selection leaves it out", () => {
    expect(askToolName(bot(), claude)).toBe("ask_user");
    expect(askToolName(bot({ deny: ["mcp:ogb:ask_user"] }), claude)).toBeUndefined();
    expect(askToolName(bot({ allow: ["mcp:agents:*"] }), claude)).toBeUndefined();
    expect(askToolName(bot(), () => undefined)).toBeUndefined();
    expect(askToolName(null, claude)).toBeUndefined();
  });
});
