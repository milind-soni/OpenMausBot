import { describe, expect, it, vi } from "vitest";

import { shouldSettleRequestCard } from "../../shared/ask-question.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { RequestOutcome, RuntimeEvent } from "../contracts.ts";
import type { HandoffView } from "../coordinator.ts";
import type { Notification } from "../notify.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message } from "../store.ts";
import { askToolName, closeCard, createAskCards, resolvedCard, type AskCardsDeps } from "./ask-cards.ts";

const AUTH = { kind: "session", scopes: ["client"], session: { id: "s", email: "cleo@acme.test" } } as unknown as RequestAuth;
const QUESTION = "What wording should the new footer text use?";

function world(options: { inboxThread?: string; live?: string[]; privateThreads?: string[] } = {}) {
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
      written.push(message);
      const full = { id: `m${++ids}`, at: 1_000 + ids, ...message } as Message;
      threads.set(threadId, [...rows(threadId), full]);
      return full;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
      written.push(patch);
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
  const answered: Array<{ id: string; text: string }> = [];
  const notified: Notification[] = [];
  const answers: Array<{ threadId: string; requestId: string; message?: string; behavior?: "close" }> = [];
  const live = new Set(options.live ?? []);
  const written: unknown[] = [];
  let refuse: { status: number; error: string } | null = null;
  let afterAnswer: (() => void) | null = null;
  const deps: AskCardsDeps = {
    store: store as unknown as AskCardsDeps["store"],
    node: (id) => nodes.get(id),
    delegatorOf: (threadId) => (threadId === "work" ? { threadId: "inbox", botId: "scout" } : undefined),
    notify: (notification) => { if (notification) notified.push(notification); },
    copiedInto: (inboxThreadId) => inboxThreadId === options.inboxThread,
    keptPrivate: (threadId) => (options.privateThreads ?? []).includes(threadId),
    live: (_threadId, requestId) => live.has(requestId),
    answerCard: vi.fn(async (input) => {
      if (refuse) return { ok: false as const, ...refuse };
      answers.push({ threadId: input.threadId, requestId: input.requestId, ...(input.behavior === "close" ? { behavior: "close" as const }
        : { message: input.message }) });
      live.delete(input.requestId);
      afterAnswer?.();
      return { ok: true as const };
    }),
    answeredIn: (threadId, requestId) => (threadId === "inbox" && requestId.startsWith("req") ? "work" : threadId),
    now: () => 0,
    answerNode: (id, text) => {
      const parked = nodes.get(id);
      if (!parked || parked.status !== "waiting") return false;
      answered.push({ id, text });
      nodes.set(id, { ...parked, status: "queued", question: undefined, answer: text } as HandoffView);
      return true;
    },
  };
  const cards = createAskCards(deps);
  const node = (over: Partial<HandoffView> = {}): HandoffView => {
    const made = { id: "as_1", rootId: "root", parentId: "root", threadId: "work", botId: "ledger", key: "ledger", text: "Fix it", createdAt: 1_000,
      startedAt: 1_000, status: "waiting", result: "", reported: false, executions: 1, lastProgressAt: 1_000, kind: "work",
      restarts: 0, mode: "work", reply: "resume", ...over } as HandoffView;
    nodes.set(made.id, made);
    return made;
  };
  nodes.set("root", { id: "root", rootId: "root", threadId: "inbox", botId: "scout" } as HandoffView);
  const say = (threadId: string, text: string) => store.appendMessage(threadId, { role: "bot", kind: "text", text });
  return { cards, store, rows, notified, answers, answered, node, say, deps, written, open: (requestId: string) => live.add(requestId),
    refuse: (value: typeof refuse) => { refuse = value; }, afterAnswer: (value: typeof afterAnswer) => { afterAnswer = value; } };
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

  it("keeps the localized chip's question identical to its English fallback, without the default answer", () => {
    const w = world();
    w.cards.park(w.node(), "CSV or Excel?\nDefault: CSV");
    expect(w.rows("inbox")[0]?.tool).toMatchObject({
      name: "Ledger needs your input: CSV or Excel?",
      nameCode: "chat.notice.teammateNeedsInput",
      nameParams: { name: "Ledger", question: "CSV or Excel?" },
    });
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

  it("asks a room member's question with the same card, in place of the member's own line, and answers the waiting work from it", () => {
    const room = world();
    room.store.appendMessage("work", { role: "bot", kind: "text", text: "My part is done.", from: { botId: "scout", name: "Scout", color: "orange" } });
    room.store.appendMessage("work", { role: "bot", kind: "text", text: `Checked.\nNEEDS INPUT: ${QUESTION}`, from: { botId: "ledger", name: "Ledger", color: "teal" } });
    const member = room.node({ groupId: "room", question: QUESTION });
    room.cards.park(member, QUESTION);
    const [other, line, card] = room.rows("work");
    expect(other!.text).toBe("My part is done.");
    expect(line).toMatchObject({ text: "Checked.", from: { botId: "ledger" } });
    expect(card).toMatchObject({ kind: "options", from: { botId: "ledger" }, card: { subtitle: QUESTION, requestId: "needs-input-as_1-1" } });
    expect(room.notified.map((notification) => notification.kind)).toEqual(["question"]);
    expect(room.cards.answerParked("work", "needs-input-as_1-1", "Short and friendly")).toBe(true);
    expect(room.answered).toEqual([{ id: "as_1", text: "Short and friendly" }]);
    expect(room.rows("work").find((row) => row.card)!.card).toMatchObject({ answered: "answer", answeredText: "Short and friendly" });
    expect(room.cards.answerParked("work", "needs-input-as_1-1", "once more")).toBe(false);
  });

  it("keeps a parked card's chip, and leaves telling the person to the card itself", () => {
    const card = world({ inboxThread: "inbox" });
    card.cards.park(card.node({ cards: ["m9"] }), "Waiting on the person: connect Gmail");
    expect(card.rows("inbox").map((row) => row.tool?.name)).toEqual(["Ledger needs your input: Waiting on the person: connect Gmail"]);
    expect(card.notified).toEqual([]);
  });
});

describe("at Full access a teammate's question goes to its requester", () => {
  it("shows who decides, in place of the line, with no chip and no notification, and then what was picked and by whom", () => {
    const w = world({ inboxThread: "inbox" });
    w.say("work", `Checked.\nNEEDS INPUT: CSV or Excel?\nDefault: CSV`);
    const node = w.node({ decide: { default: "CSV" }, question: "CSV or Excel?\nDefault: CSV" });
    w.cards.park(node, "CSV or Excel?\nDefault: CSV");
    const card = () => w.rows("work").find((row) => row.card)!.card!;
    expect(w.rows("work")[0]!.text).toBe("Checked.");
    expect(card()).toMatchObject({ subtitle: "CSV or Excel?", options: [], answered: "answer", answeredBy: { kind: "bot", name: "Scout" } });
    expect(card().answeredText).toBeUndefined();
    expect(w.rows("inbox")).toEqual([]);
    expect(w.notified).toEqual([]);
    w.cards.park(node, "CSV or Excel?\nDefault: CSV", true);
    expect(w.rows("work").filter((row) => row.card)).toHaveLength(1);

    w.cards.decided({ ...node, status: "queued", answer: "CSV", answeredBy: { kind: "default" } }, "Ledger");
    expect(card()).toMatchObject({ answered: "answer", answeredText: "CSV", answeredBy: { kind: "bot", name: "Ledger" } });
    w.cards.closed({ ...node, status: "completed", outcome: "done" });
    expect(card(), "a decided question stays decided").toMatchObject({ answered: "answer", answeredText: "CSV" });
  });

  it("closes a question its requester was still deciding when the work ends without it", () => {
    const w = world();
    w.say("work", "NEEDS INPUT: CSV or Excel?");
    const node = w.node({ decide: {} });
    w.cards.park(node, "CSV or Excel?");
    w.cards.closed({ ...node, status: "cancelled", outcome: "stopped" });
    const card = w.rows("work").find((row) => row.card)!.card!;
    expect(card).toMatchObject({ answered: "unavailable", dismissed: true, stopped: true });
    expect(card.answeredBy).toBeUndefined();
  });

  it("offers the default a person's question names as a one-tap choice", () => {
    const w = world();
    w.say("work", "NEEDS INPUT: Which invoice?\nDefault: the October one");
    w.cards.park(w.node(), "Which invoice?\nDefault: the October one");
    expect(w.rows("work")[0]!.card).toMatchObject({ subtitle: "Which invoice?", options: ["the October one"] });
    expect(w.notified[0]!.body).toBe("Which invoice?");
  });
});

describe("nothing stale waits on the person", () => {
  const ask = (w: ReturnType<typeof world>, threadId: string, requestId: string, at?: { from?: Message["from"] }) =>
    w.store.appendMessage(threadId, { role: "bot", kind: "options", text: "Should I?", ...(at?.from ? { from: at.from } : {}),
      card: { title: "Your bot has a question", subtitle: "Should I?", options: ["Yes"], requestId, requestType: "question" } });

  it("a parked card's chip is not posted again after a restart, even when other lines came after it", () => {
    const w = world();
    const node = w.node({ cards: ["m9"] });
    w.cards.park(node, "Waiting on the person: sign in to notion.so");
    w.say("inbox", "Scout: something else");
    w.cards.park(node, "Waiting on the person: sign in to notion.so", true);
    expect(w.rows("inbox").filter((row) => row.tool?.name.includes("needs your input"))).toHaveLength(1);
    expect(w.notified).toEqual([]);
  });

  it("a newer question closes the bot's older one that no turn waits on any more, but not one a turn still waits on", () => {
    const w = world({ live: ["req-2", "req-3"] });
    ask(w, "work", "req-1");
    ask(w, "work", "req-2");
    ask(w, "work", "req-3");
    w.cards.askedAgain("work", "req-3", "ledger");
    expect(w.rows("work").map((row) => row.card!.answered ?? null)).toEqual(["unavailable", null, null]);
  });

  it("a bot's own reply that ends on NEEDS INPUT becomes the question card, once", () => {
    const w = world();
    w.store.appendMessage("chat", { role: "bot", kind: "text", text: "I have two drafts.\nNEEDS INPUT: Which one do you like?", turnId: "t1" });
    w.cards.ownQuestion("ledger", "chat", "t1");
    w.cards.ownQuestion("ledger", "chat", "t1");
    expect(w.rows("chat").map((row) => [row.kind, row.text])).toEqual([["text", "I have two drafts."], ["options", "Which one do you like?"]]);
    expect(w.rows("chat")[1]!.card).toMatchObject({ subtitle: "Which one do you like?", requestType: "question", options: [] });
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
    expect(finished.card(), "finished work no longer waits on anyone").toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("closes a question the work asked with its question tool once that work ends, unless a turn still waits on it", () => {
    const w = world({ live: ["req-live"] });
    const node = w.node();
    w.store.appendMessage("work", { role: "bot", kind: "options", text: "Should I?", card: { title: "Your bot has a question", subtitle: "Should I?", options: ["Yes"], requestId: "req-1", requestType: "question" } });
    w.store.appendMessage("work", { role: "bot", kind: "options", text: "Really?", card: { title: "Your bot has a question", subtitle: "Really?", options: ["Yes"], requestId: "req-live", requestType: "question" } });
    w.cards.closed({ ...node, status: "completed", outcome: "done" });
    expect(w.rows("work").map((row) => [row.card!.requestId, row.card!.answered ?? null])).toEqual([["req-1", "unavailable"], ["req-live", null]]);
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

  it("answers the card its turn waits on in the bot's own chat with exactly the person's words", async () => {
    const w = world({ live: ["req-1"] });
    const asked = question(w, "chat");
    const result = await w.cards.typed(AUTH, "chat", "What time is it?", undefined, { sendId: "send-3" });
    expect(w.answers).toEqual([{ threadId: "chat", requestId: "req-1", message: "What time is it?" }]);
    expect(result).toMatchObject({ status: 202, message: { role: "user", text: "What time is it?", replyToId: asked.id, sendId: "send-3" } });
  });

  it("files a structured question's answer under its text, as an answer typed on the card would be", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "chat", { questionRequest: { version: 1, questions: [{ question: "Should I?", options: [{ label: "Yes" }, { label: "No" }] }] } });
    await w.cards.typed(AUTH, "chat", "Not yet", undefined, {});
    expect(w.answers).toEqual([{ threadId: "chat", requestId: "req-1", message: "The user answered your questions.\n\nQ: Should I?\nA: Not yet" }]);
  });

  it("closes a card that takes no words in the bot's own chat and leaves the line to be sent as the next message", async () => {
    for (const card of [{ fixedOptions: true }, { questionRequest: { version: 1 as const, questions: [{ question: "A?", options: [{ label: "x" }] }, { question: "B?", options: [{ label: "y" }] }] } }]) {
      const w = world({ live: ["req-1"] });
      question(w, "chat", card);
      expect(await w.cards.typed(AUTH, "chat", "Something else first", undefined, {})).toBeNull();
      expect(w.answers).toEqual([{ threadId: "chat", requestId: "req-1", behavior: "close" }]);
      expect(w.rows("chat").filter((row) => row.role === "user")).toEqual([]);
    }
  });

  it("leaves a card it could not close as it is, and the line to the usual send", async () => {
    const w = world({ live: ["req-1"] });
    const asked = question(w, "chat", { fixedOptions: true });
    w.refuse({ status: 403, error: "This question is Ben's to answer." });
    expect(await w.cards.typed(AUTH, "chat", "Something else first", undefined, {})).toBeNull();
    expect(w.deps.answerCard).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-1", behavior: "close" }));
    expect(w.rows("chat")).toEqual([asked]);
  });

  it("gives a send tried again the line it wrote, and touches no card it finds open then", async () => {
    for (const next of [{ fixedOptions: true }, {}]) {
      const w = world({ live: ["req-1"] });
      question(w, "chat");
      const first = await w.cards.typed(AUTH, "chat", "What time is it?", undefined, { sendId: "send-4" });
      question(w, "chat", { requestId: "req-2", ...next });
      w.open("req-2");
      const again = await w.cards.typed(AUTH, "chat", "What time is it?", undefined, { sendId: "send-4" });
      expect(again).toEqual({ status: 202, message: first!.message });
      expect(w.answers.map((answer) => answer.requestId)).toEqual(["req-1"]);
      expect(await w.cards.typed(AUTH, "chat", "Something else", undefined, { sendId: "send-4" }), "other words go on to be refused").toBeNull();
      expect(w.answers).toHaveLength(1);
      expect(w.rows("chat").filter((row) => row.role === "user")).toHaveLength(1);
    }
  });

  it("answers once when the same send arrives twice at the same time", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "chat");
    const [one, two] = await Promise.all([1, 2].map(() => w.cards.typed(AUTH, "chat", "What time is it?", undefined, { sendId: "send-5" })));
    expect(two?.message?.id).toBe(one?.message?.id);
    expect(w.answers).toHaveLength(1);
  });

  it("closes one card when the same send arrives twice at once and a new card opens before its line is written", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "chat", { fixedOptions: true });
    w.afterAnswer(() => {
      w.afterAnswer(null);
      question(w, "chat", { requestId: "req-2", fixedOptions: true });
      w.open("req-2");
    });
    const tries = await Promise.all([1, 2].map(() => w.cards.typed(AUTH, "chat", "Something else first", undefined, { sendId: "send-6" })));
    expect(tries).toEqual([null, null]);
    expect(w.answers.map((answer) => answer.requestId)).toEqual(["req-1"]);
  });

  it("lets a send whose close was refused try again", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "chat", { fixedOptions: true });
    w.refuse({ status: 409, error: "The request is no longer open." });
    expect(await w.cards.typed(AUTH, "chat", "Something else first", undefined, { sendId: "send-7" })).toBeNull();
    w.refuse(null);
    expect(await w.cards.typed(AUTH, "chat", "Something else first", undefined, { sendId: "send-7" })).toBeNull();
    expect(w.answers).toEqual([{ threadId: "chat", requestId: "req-1", behavior: "close" }]);
  });

  it("leaves a line in the bot's own chat to the usual send while two question cards wait there", async () => {
    for (const second of [{}, { fixedOptions: true }]) {
      const w = world({ live: ["req-1", "req-2"] });
      const first = question(w, "chat");
      question(w, "chat", { requestId: "req-2", ...second });
      expect(await w.cards.typed(AUTH, "chat", "What time is it?", undefined, {})).toBeNull();
      expect(await w.cards.typed(AUTH, "chat", "What time is it?", first, {})).toBeNull();
      expect(w.answers).toEqual([]);
    }
  });

  it("leaves a line in the bot's own chat to the usual send when no turn waits on its card, it is Stop, it replies to another line or carries a file", async () => {
    const idle = world();
    question(idle, "chat");
    expect(await idle.cards.typed(AUTH, "chat", "Take the second one", undefined, {})).toBeNull();
    const busy = world({ live: ["req-1"] });
    question(busy, "chat");
    const other = busy.say("chat", "I checked.");
    expect(await busy.cards.typed(AUTH, "chat", "stop", undefined, {})).toBeNull();
    expect(await busy.cards.typed(AUTH, "chat", "Thanks", other, {})).toBeNull();
    expect(await busy.cards.typed(AUTH, "chat", 'Look <attached-image path="a.png" />', undefined, {})).toBeNull();
    expect(idle.answers).toEqual([]);
    expect(busy.answers).toEqual([]);
  });

  it("passes on why an answer was refused, and writes no line", async () => {
    const w = world({ live: ["req-1"] });
    question(w, "work");
    w.refuse({ status: 403, error: "This question is Ben's to answer." });
    expect(await w.cards.typed(AUTH, "work", "Yes", undefined, {})).toEqual({ status: 403, error: "This question is Ben's to answer." });
    expect(w.rows("work").filter((row) => row.role === "user")).toEqual([]);
  });
});

describe("a reminder of work parked on the person", () => {
  const closesAt = 2 * 24 * 60 * 60_000;

  it("names the question and when it closes, and adds no second row", () => {
    const w = world();
    const node = w.node({ status: "waiting", question: "Which region?\nDefault: eu-west" });
    w.cards.remind(node, closesAt);
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]).toMatchObject({ kind: "question", botId: "ledger", threadId: "work", body: expect.stringContaining("Which region?") });
    expect(w.notified[0]!.body).toContain("2 days");
    expect(w.notified[0]!.body).not.toContain("eu-west");
    expect(w.rows("work")).toEqual([]);
  });

  it("does not read a card's internal wait description to the person", () => {
    const w = world();
    w.cards.remind(w.node({ status: "waiting", question: "Waiting on the person: provide API key", cards: ["m1"] }), closesAt);
    expect(w.notified[0]!.body).not.toContain("Waiting on the person");
    expect(w.notified[0]!.body).toContain("2 days");
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

  it("links to a sign-in, password or app to connect left open in the work, once, and says when it no longer waits", () => {
    const desk = world();
    desk.cards.showWaitingOnCardChip("work", { kind: "sign-in", messageId: "c1", label: "example.com" }, asker);
    desk.cards.showWaitingOnCardChip("work", { kind: "sign-in", messageId: "c1", label: "example.com" }, asker);
    desk.cards.showWaitingOnCardChip("work", { kind: "connect", messageId: "c2", label: "Gmail" }, asker);
    expect(desk.rows("inbox")).toMatchObject([
      { kind: "activity", from: { botId: "ledger", name: "Ledger" }, threadRef: { botId: "ledger", threadId: "work", title: "Pricing page: fix" },
        tool: { name: "Waiting on you to sign in to example.com in @Ledger", nameCode: "chat.notice.waitingSignInElsewhere", nameParams: { name: "Ledger", label: "example.com" } } },
      { tool: { name: "Waiting on you to connect Gmail in @Ledger", nameCode: "chat.notice.waitingConnectElsewhere" } },
    ]);
    desk.cards.settleWaitingOnCardChip("work", "c1");
    const [settled, open] = desk.rows("inbox");
    expect(settled?.tool).toMatchObject({ name: "@Ledger no longer waits on you", ok: true });
    expect(settled?.tool?.nameCode).toBeUndefined();
    expect(settled?.threadRef).toMatchObject({ threadId: "work" });
    expect(open?.tool?.name).toBe("Waiting on you to connect Gmail in @Ledger");
  });

  it("says the same line waits again when the card waits again, without a second line", () => {
    const desk = world();
    desk.cards.reopenWaitingOnCardChip("work", "c1");
    expect(desk.rows("inbox")).toEqual([]);
    desk.cards.showWaitingOnCardChip("work", { kind: "sign-in", messageId: "c1", label: "example.com" }, asker);
    desk.cards.settleWaitingOnCardChip("work", "c1");
    desk.cards.reopenWaitingOnCardChip("work", "c1");
    const rows = desk.rows("inbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toMatchObject({ name: "Waiting on you to sign in to example.com in @Ledger", nameCode: "chat.notice.waitingSignInElsewhere" });
    expect(rows[0]!.tool?.ok).toBeUndefined();
    desk.cards.settleWaitingOnCardChip("work", "c1");
    expect(desk.rows("inbox")[0]!.tool).toMatchObject({ name: "@Ledger no longer waits on you", ok: true });
  });

  it("keeps a private conversation's card, site and title out of a conversation that belongs to someone else", () => {
    const team = world({ privateThreads: ["work"] });
    team.cards.showWaitingOnCardChip("work", { kind: "sign-in", messageId: "c1", label: "example.com" }, asker);
    expect(team.rows("inbox")).toEqual([]);
  });

  it("leaves a settled chip settled when its conversation has since become private to someone else", () => {
    const privateThreads: string[] = [];
    const team = world({ privateThreads });
    team.cards.showWaitingOnCardChip("work", { kind: "sign-in", messageId: "c1", label: "example.com" }, asker);
    team.cards.settleWaitingOnCardChip("work", "c1");
    privateThreads.push("work");
    team.cards.reopenWaitingOnCardChip("work", "c1");
    expect(team.rows("inbox")[0]!.tool).toMatchObject({ name: "@Ledger no longer waits on you", ok: true });
  });

  it("leaves a card's chip out of the person's inbox, which has the card, and out of work nobody handed on", () => {
    const team = world({ inboxThread: "inbox" });
    team.cards.showWaitingOnCardChip("work", { kind: "password", messageId: "c1", label: "API key" }, asker);
    expect(team.rows("inbox")).toEqual([]);
    const desk = world();
    desk.cards.showWaitingOnCardChip("inbox", { kind: "password", messageId: "c1", label: "API key" }, asker);
    desk.cards.showWaitingOnCardChip("work", { kind: "question", messageId: "c2", label: "Which?" }, asker);
    expect(desk.rows("inbox")).toEqual([]);
  });
});

describe("closing a card the person moved past", () => {
  type Resolved = Extract<RuntimeEvent, { type: "request.resolved" }>;
  /** The server's side: question cards by request, the live link of each, and what the engine settling one writes. */
  const server = () => {
    const cards = new Map<string, OptionCardData>(), live = new Map<string, string>(), closing = new Set<string>();
    const ask = (requestId: string) => { cards.set(requestId, { title: "Which?", subtitle: "Which?", requestId, requestType: "question", options: [], fixedOptions: true }); live.set(`chat:${requestId}`, requestId); };
    // As the request.resolved handler: a live request's card settles, and the request is no longer live.
    const settle = (requestId: string, behavior: Resolved["behavior"], source: Resolved["source"] = "user") => {
      if (!live.has(`chat:${requestId}`)) return;
      const card = cards.get(requestId)!;
      if (shouldSettleRequestCard(card, source)) cards.set(requestId, resolvedCard(card, { type: "request.resolved", threadId: "chat", requestId, behavior, source } as Resolved, closing));
      live.delete(`chat:${requestId}`);
    };
    // As Stop or the turn ending: a question card stays for a late answer, and its request is no longer live.
    const turnEnds = () => live.clear();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const close = (requestId: string, decline: () => Promise<RequestOutcome>) => closeCard({ key: `chat:${requestId}`, live, closing, decline });
    // An engine that takes a decline only once released, and settles the request then unless something already did.
    const slowDecline = (requestId: string) => async (): Promise<RequestOutcome> => {
      await held;
      if (!live.has(`chat:${requestId}`)) return "unavailable";
      settle(requestId, "deny");
      return "rejected";
    };
    return { cards, live, closing, ask, settle, turnEnds, release, close, slowDecline };
  };

  it("reads closed without an answer once the engine took the decline, and records it as no answer", async () => {
    const s = server();
    s.ask("req-1");
    expect(await s.close("req-1", async () => { s.settle("req-1", "deny"); return "rejected"; })).toBe("rejected");
    expect(s.cards.get("req-1")).toMatchObject({ answered: "unavailable", dismissed: true });
    expect([...s.live.keys()]).toEqual([]);
    expect(s.closing.size).toBe(0);
  });

  it("keeps a tap that wins while the decline is on its way, and leaves no dead request live for the next card", async () => {
    const s = server();
    s.ask("req-1");
    const closing = s.close("req-1", s.slowDecline("req-1"));
    expect(s.live.has("chat:req-1"), "a tap still finds the card's request").toBe(true);
    s.settle("req-1", "answer");
    s.release();
    expect(await closing).toBe("unavailable");
    expect(s.cards.get("req-1")).toMatchObject({ answered: "answer", dismissed: false });
    expect([...s.live.keys()]).toEqual([]);
    s.ask("req-2");
    expect([...s.live.keys()], "the next card is the only one waiting").toEqual(["chat:req-2"]);
    expect(await s.close("req-2", async () => { s.settle("req-2", "deny"); return "rejected"; })).toBe("rejected");
    expect(s.cards.get("req-2")).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("leaves no dead request live when Stop or the turn ending beats the decline", async () => {
    const s = server();
    s.ask("req-1");
    const closing = s.close("req-1", s.slowDecline("req-1"));
    s.turnEnds();
    s.release();
    expect(await closing).toBe("unavailable");
    expect(s.cards.get("req-1")?.answered, "open for a late answer, as after any Stop").toBeUndefined();
    expect([...s.live.keys()]).toEqual([]);
    s.ask("req-2");
    expect([...s.live.keys()]).toEqual(["chat:req-2"]);
    s.settle("req-2", "deny", "system");
    expect(s.cards.get("req-2")?.answered, "a decline that is not a close's own settles as before").toBeUndefined();
  });

  it("stays open and live for a tap when the engine did not take the decline, or delivering it failed", async () => {
    for (const decline of [async () => "unavailable" as const, async (): Promise<"rejected"> => { throw new Error("broker gone"); }]) {
      const s = server();
      s.ask("req-1");
      expect(await s.close("req-1", decline)).toBe("unavailable");
      expect(s.cards.get("req-1")?.answered).toBeUndefined();
      expect(s.live.get("chat:req-1")).toBe("req-1");
      expect(s.closing.size).toBe(0);
      s.settle("req-1", "answer");
      expect(s.cards.get("req-1")).toMatchObject({ answered: "answer" });
    }
  });

  it("delivers nothing for a card no turn waits on", async () => {
    const s = server();
    const decline = vi.fn(async () => "rejected" as const);
    expect(await s.close("req-1", decline)).toBe("unavailable");
    expect(decline).not.toHaveBeenCalled();
  });
});

describe("askToolName", () => {
  const bot = (toolScope?: BotRecord["toolScope"]) => ({ modelSelection: { instanceId: "claude", model: "m" }, toolScope }) as BotRecord;
  const claude = () => ({ kind: "mcp" as const, server: "ogb", name: "ask_user" });

  it("names the engine's question tool as its model calls it, unless the bot's tool selection leaves it out", () => {
    expect(askToolName(bot(), claude)).toBe("mcp__ogb__ask_user");
    expect(askToolName(bot(), () => ({ kind: "native", name: "AskQuestion" }))).toBe("AskQuestion");
    expect(askToolName(bot({ deny: ["mcp:ogb:ask_user"] }), claude)).toBeUndefined();
    expect(askToolName(bot({ allow: ["mcp:agents:*"] }), claude)).toBeUndefined();
    expect(askToolName(bot(), () => undefined)).toBeUndefined();
    expect(askToolName(null, claude)).toBeUndefined();
  });
});
