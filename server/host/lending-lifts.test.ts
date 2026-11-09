import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_SECRET_TARGET } from "../../shared/credential-request.ts";
import { parseOptionsCardInput } from "../../shared/options-card.ts";
import { liveDecisionRefusal } from "../../shared/live-approval.ts";
import { CARRY_ON_MS } from "../computer-asks.ts";
import { DATA_DIR } from "../config.ts";
import "../server-line-packs.ts";
import { Store } from "../store.ts";
import { createLendingLifts, handedInSince, type LendingLiftDeps } from "./lending-lifts.ts";
import { createPersonWaits } from "./person-waits.ts";

const OWNER = "p_owner";

type Line = { id: string; role: string; kind?: string; card?: any; tool?: { name: string }; text?: string };

function world({ room = false, busy = false, owners = true, stopped = false, at = 0 } = {}) {
  const lines: Line[] = [{ id: "u1", role: "user", kind: "text" }];
  const state = { token: "t1", changed: ["MEMORY.md"], accepted: [] as string[] };
  const continued: unknown[] = [];
  const timers: Array<() => void> = [];
  /** Who is answering right now, as answeringCardAs records it before the card says. */
  const answering = { person: undefined as string | undefined };
  const deps: LendingLiftDeps = {
    store: {
      messagesFor: () => lines,
      activePath: () => lines,
      appendMessage: (_: string, message: any) => { const line = { id: `m${lines.length}`, ...message }; lines.push(line); return line; },
      patchMessage: (_: string, id: string, patch: any) => { const line = lines.find((candidate) => candidate.id === id)!; Object.assign(line, patch); return line; },
      bot: () => ({ id: "b1", name: "Postmeister", color: "red" }),
      botByThread: () => ({ id: "b1" }),
      groupByThread: () => (room ? { id: "g1", name: "Room" } : undefined),
      projectBotForTask: () => ({ busy: false, activity: "working" }),
      setTaskActivity: () => {},
      taskByThread: () => ({ threadId: "t1" }),
    } as never,
    memory: {
      info: () => ({ token: state.token, changed: state.changed }),
      accept: (_, token) => { if (token !== state.token) return false; state.accepted.push(token); return true; },
    },
    words: (_, file) => `words of ${file}`,
    // As index.ts reads it: the card's recorded answerer, else whoever is answering now.
    ownersAnswer: (card) => (card.answeredBy ? (card.answeredBy.kind === "session" ? card.answeredBy.person : undefined) : answering.person) === OWNER,
    stopped: () => stopped,
    threadBusy: () => busy,
    queued: () => false,
    continueRequest: async (...args) => { continued.push(args); },
    language: () => undefined,
    device: () => "Mac",
    notify: vi.fn(),
    decide: vi.fn(),
    setTimer: ((run: () => void) => { timers.push(run); return {}; }) as never,
    now: () => at,
  };
  const lifts = createLendingLifts(deps);
  /** One answer through the respond route: who answers, then the card records them (answeringCardAs). */
  /** `null`: nobody provable answers (a process on the machine, a bot). */
  const answer = (requestId: string, behavior: string, person: string | null = owners ? OWNER : "p_guest") => {
    answering.person = person ?? undefined;
    const result = lifts.resolve("t1", requestId, behavior);
    const line = lines.find((candidate) => candidate.card?.requestId === requestId);
    if (line?.card?.answered && !line.card.answeredBy && person) line.card.answeredBy = { kind: "session", person };
    answering.person = undefined;
    return result;
  };
  return { lines, state, continued, timers, deps, lifts, answer };
}
const input = { botId: "b1", threadId: "t1", requestMessageId: "u1", memoryChanged: true, outside: false };
const cardOf = (lines: Line[]) => lines.filter((line) => line.card?.lendingLift).at(-1)!.card;

describe("the card that lifts a lock on the lent computer (server/host/lending-lifts.ts)", () => {
  it("shows what changed, notifies once, and keeps one card per line of the owner's", () => {
    const { lines, deps, lifts } = world();
    expect(lifts.raise(input)).toBe("open");
    expect(lifts.raise(input)).toBe("open");
    expect(lines.filter((line) => line.card)).toHaveLength(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    const card = cardOf(lines);
    expect(card.title).toBe("Let Postmeister use your Mac for this?");
    expect(card.subtitle).toBe("Its notes changed in work you didn't write:\n- MEMORY.md\nwords of MEMORY.md");
    expect(card.options).toEqual(["Allow", "Not now"]);
    expect(card.lendingLift).toEqual({ requestMessageId: "u1", memoryToken: "t1" });
  });
  it("a long list says where the rest is, so what's cut is never silently gone", () => {
    const { lines, state, lifts } = world();
    state.changed = Array.from({ length: 200 }, (_, i) => `memory/file-${i}.md`);
    lifts.raise(input);
    expect(cardOf(lines).subtitle.endsWith("More in this bot's settings, under Memory.")).toBe(true);
  });
  it("what it allows stays what it shows while it waits", () => {
    const { lines, state, lifts } = world();
    lifts.raise(input);
    state.token = "t2";
    state.changed = ["MEMORY.md", "memory/people.md"];
    lifts.raise(input);
    expect(cardOf(lines).lendingLift.memoryToken).toBe("t2");
    expect(cardOf(lines).subtitle).toContain("memory/people.md");
  });
  it("only the owner's answer counts", () => {
    const { lines, state, lifts, answer } = world({ owners: false });
    lifts.raise(input);
    const refused = answer(cardOf(lines).requestId, "allow")!;
    expect(refused.status).toBe(403);
    expect(state.accepted).toEqual([]);
    expect(cardOf(lines).answered).toBeUndefined();
  });
  it.each([
    [undefined, "Choose Allow or Not now.", "Only you can allow this, from one of your own devices."],
    ["pt-br", "Escolha Permitir ou Agora não.", "Só você pode permitir isso, em um dos seus dispositivos."],
    ["de", "Wähle Erlauben oder Nicht jetzt.", "Nur du kannst dies erlauben, von einem deiner eigenen Geräte aus."],
  ])("writes answer refusals in the conversation language %s", (language, choose, ownerOnly) => {
    const { lines, deps, lifts, answer, state } = world();
    deps.language = () => language;
    lifts.raise(input);
    const { requestId } = cardOf(lines);
    expect(answer(requestId, "answer")).toEqual({ status: 400, body: { error: choose } });
    expect(answer(requestId, "allow", "p_guest")).toEqual({ status: 403, body: { error: ownerOnly } });
    expect(cardOf(lines).answered).toBeUndefined();
    expect(state.accepted).toEqual([]);
  });
  it("a change after it was shown lifts nothing: the card shows what's there now", () => {
    const { lines, state, continued, lifts, answer } = world();
    lifts.raise(input);
    state.token = "t2";
    state.changed = ["memory/planted.md"];
    expect(answer(cardOf(lines).requestId, "allow")).toEqual({ status: 200, body: { ok: true, outcome: "changed-again" } });
    expect(state.accepted).toEqual([]);
    expect(cardOf(lines).answered).toBeUndefined();
    expect(cardOf(lines).subtitle).toContain("memory/planted.md");
    expect(continued).toEqual([]);
    expect(answer(cardOf(lines).requestId, "allow")!.body.outcome).toBe("allowed-once");
    expect(state.accepted).toEqual(["t2"]);
  });
  it("Allow carries the request on, waiting for the turn to end", () => {
    const { lines, deps, continued, timers, lifts, answer } = world({ busy: true });
    lifts.raise(input);
    answer(cardOf(lines).requestId, "allow");
    expect(continued).toEqual([]);
    deps.threadBusy = () => false;
    // A fresh closure reads deps, as index.ts's real threadBusy does.
    timers.shift()!();
    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject(["b1", expect.stringContaining("Carry on"), { threadId: "t1", cardContinuation: true, requestMessageId: "u1" }]);
  });
  it("a person's Stop holds: the request doesn't go on by itself afterwards", () => {
    const { lines, continued, lifts, answer } = world({ stopped: true });
    lifts.raise(input);
    answer(cardOf(lines).requestId, "allow");
    expect(continued).toEqual([]);
  });
  it("names a changed skill once, without the folders it lives in", () => {
    const { lines, state, lifts } = world();
    const skill = "/data/task-workspaces/b1/t9/.claude/skills/quote-plan";
    state.changed = ["MEMORY.md", skill, `${skill}/SKILL.md`, "/data/projects/site/CLAUDE.md"];
    lifts.raise(input);
    const named = cardOf(lines).subtitle.split("\n").filter((line: string) => line.startsWith("- "));
    expect(named).toEqual(["- MEMORY.md", "- .claude/skills/quote-plan/SKILL.md", "- /data/projects/site/CLAUDE.md"]);
  });
  it("someone writing since leads: the request doesn't go on over them", () => {
    const { lines, continued, lifts, answer } = world();
    lifts.raise(input);
    lines.push({ id: "u2", role: "user", kind: "text" });
    answer(cardOf(lines).requestId, "allow");
    expect(continued).toEqual([]);
  });
  it("in a group chat it says to ask again, since nothing goes on by itself there", () => {
    const { lines, continued, lifts, answer } = world({ room: true });
    lifts.raise(input);
    answer(cardOf(lines).requestId, "allow");
    expect(continued).toEqual([]);
    expect(lines.at(-1)!.tool!.name).toBe("Allowed. Ask again to go on.");
  });
  it("Not now is remembered for that line and answers stay settled", () => {
    const { lines, state, lifts, answer } = world();
    lifts.raise(input);
    const { requestId } = cardOf(lines);
    expect(answer(requestId, "deny")!.body.outcome).toBe("rejected");
    expect(state.accepted).toEqual([]);
    expect(lifts.declined("t1", "u1")).toBe(true);
    expect(lifts.raise(input)).toBe("declined");
    expect(lines.filter((line) => line.card)).toHaveLength(1);
    expect(answer(requestId, "allow")!.body).toEqual({ ok: true, outcome: "rejected", alreadySettled: true });
    expect(lifts.declined("t1", "u2")).toBe(false);
  });
  it("what came in from outside is let through only for the line it was allowed for, up to where it was allowed", () => {
    const { lines, lifts, answer } = world();
    lifts.raise({ ...input, memoryChanged: false, outside: true });
    expect(lifts.outsideAllowed("t1", "u1")).toBeNull();
    expect(cardOf(lines).subtitle).toContain("Allow lets only this message of yours use your Mac.");
    answer(cardOf(lines).requestId, "allow");
    expect(lifts.outsideAllowed("t1", "u1")).toEqual({ index: lines.findIndex((line) => line.card?.lendingLift), at: 0 });
    expect(lifts.outsideAllowed("t1", "u2")).toBeNull();
    expect(lifts.outsideAllowed("t1", undefined)).toBeNull();
  });
  it("in a conversation a bot opened it says so, and Allow records when, so work handed in after shuts it again", () => {
    const { lines, lifts, answer } = world({ at: 42 });
    lifts.raise({ ...input, memoryChanged: false, outside: true, botOpened: true });
    expect(cardOf(lines).subtitle).toBe("A bot opened this conversation with work for this bot. Allow lets only this message of yours use your Mac.");
    expect(cardOf(lines).lendingLift).toEqual({ requestMessageId: "u1", outside: true, botOpened: true });
    expect(lifts.outsideAllowed("t1", "u1")).toBeNull();
    answer(cardOf(lines).requestId, "allow");
    expect(cardOf(lines).lendingLift).toEqual({ requestMessageId: "u1", outside: true, botOpened: true, allowedAt: 42 });
    expect(lifts.outsideAllowed("t1", "u1")).toEqual({ index: lines.findIndex((line) => line.card?.lendingLift), at: 42 });
  });
  it("an allowed card with no time on it lets nothing through", () => {
    const { lines, lifts } = world();
    lines.push({ id: "c1", role: "bot", card: { requestId: "lending-lift-x", answered: "allow", answeredBy: { kind: "session", person: OWNER }, lendingLift: { requestMessageId: "u1", outside: true } } });
    expect(lifts.outsideAllowed("t1", "u1")).toBeNull();
  });
  it("a memory card allows nothing from outside", () => {
    const { lines, lifts, answer } = world();
    lifts.raise(input);
    answer(cardOf(lines).requestId, "allow");
    expect(lifts.outsideAllowed("t1", "u1")).toBeNull();
  });
  it("only the owner's own answer lets outside words through, read from the card as it is now", () => {
    for (const answeredBy of [{ kind: "bot", person: undefined }, { kind: "session", person: "p_guest" }, { kind: "loopback" }, undefined]) {
      const { lines, lifts } = world();
      lines.push({ id: "w1", role: "bot", card: { requestId: "lending-lift-forged", answered: "allow", ...(answeredBy ? { answeredBy } : {}), lendingLift: { requestMessageId: "u1", outside: true, allowedAt: 5 } } });
      expect(lifts.outsideAllowed("t1", "u1"), JSON.stringify(answeredBy)).toBeNull();
    }
  });
  it("another person, a process on the machine or a bot can't answer it", () => {
    for (const person of ["p_guest", null]) {
      const { lines, state, lifts, answer } = world();
      lifts.raise({ ...input, outside: true });
      expect(answer(cardOf(lines).requestId, "allow", person)!.status).toBe(403);
      expect(cardOf(lines).answered).toBeUndefined();
      expect(state.accepted).toEqual([]);
      expect(lifts.outsideAllowed("t1", "u1")).toBeNull();
    }
  });
  it("a typed answer or anything but Allow and Not now settles nothing", () => {
    const { lines, lifts, answer } = world();
    lifts.raise(input);
    expect(answer(cardOf(lines).requestId, "answer")!.status).toBe(400);
    expect(cardOf(lines).answered).toBeUndefined();
  });
  it("is answered on screen only: a Live call or a reaction can't say yes to it", () => {
    const { lines, lifts } = world();
    lifts.raise(input);
    expect(liveDecisionRefusal(cardOf(lines))).toBe("This request is reviewed on screen.");
  });
  it("a bot can't make one: a card it writes keeps only its title, words and choices", () => {
    const parsed = parseOptionsCardInput({ title: "Allow?", subtitle: "x", options: ["Allow", "Not now"], lendingLift: { requestMessageId: "u1", outside: true }, answered: "allow", answeredBy: { kind: "session", person: OWNER } });
    expect(parsed).toEqual({ ok: true, value: { title: "Allow?", subtitle: "x", options: ["Allow", "Not now"] } });
  });
  it("a card the harness settled (stopped, expired) is no decline: the line gets a new one", () => {
    for (const settled of [{ stopped: true }, { expired: true }, { answered: "unavailable", dismissed: true }]) {
      const { lines, lifts, answer } = world();
      lifts.raise(input);
      Object.assign(cardOf(lines), settled);
      expect(lifts.declined("t1", "u1")).toBe(false);
      expect(lifts.raise(input)).toBe("open");
      expect(lines.filter((line) => line.card?.lendingLift)).toHaveLength(2);
      expect(answer(lines.filter((line) => line.card?.lendingLift)[0]!.card.requestId, "allow")!.body.alreadySettled).toBe(true);
    }
  });
  it("counts work handed into the conversation after he allowed it, made or first run then; not its own turns or other conversations", () => {
    const node = (extra: Record<string, unknown>) => ({ id: "n1", rootId: "root", threadId: "t1", createdAt: 10, ...extra });
    expect(handedInSince([node({})], "t1", 50)).toBe(false);
    expect(handedInSince([node({ createdAt: 60 })], "t1", 50)).toBe(true);
    expect(handedInSince([node({ startedAt: 60 })], "t1", 50)).toBe(true);
    expect(handedInSince([node({ createdAt: 60, id: "root" })], "t1", 50)).toBe(false);
    expect(handedInSince([node({ createdAt: 60, threadId: "t2" })], "t1", 50)).toBe(false);
  });
  it("answers only its own cards", () => {
    expect(world().answer("something-else", "allow")).toBeNull();
  });
});

describe("Allow on the card, in a conversation whose waiting state follows its open cards", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  function conversation({ stopped = false, rejects = false } = {}) {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    createPersonWaits({ store, notify: () => {}, threadsWithCards: () => [] });
    const bot = store.createBot({ name: "Postmeister" });
    const thread = bot.threadId;
    const request = store.appendMessage(thread, { role: "user", kind: "text", text: "Save it into my folder" });
    const task = () => store.taskByThread(bot.id, thread)!;
    const continued: unknown[] = [];
    const timers: Array<() => void> = [];
    let at = 0;
    const lifts = createLendingLifts({
      store,
      memory: { info: () => ({ token: "t1", changed: [] }), accept: () => true },
      words: () => undefined, ownersAnswer: () => true, stopped: () => stopped,
      // As index.ts's threadBusy reads a thread with no dispatch claim.
      threadBusy: (botId, threadId) => store.taskByThread(botId, threadId)?.busy === true,
      queued: () => false,
      continueRequest: async (...args) => { continued.push(args); if (rejects) throw new Error("the engine is gone"); },
      language: () => undefined, device: () => "PC", notify: () => {}, decide: () => {},
      setTimer: ((run: () => void) => { timers.push(run); return {}; }) as never,
      now: () => at,
    });
    /** The turn answering the request asks for a password, then for the PC, and leaves both cards open. */
    const turnRaisesCards = () => {
      store.setTaskActivity(bot.id, thread, "working");
      store.appendMessage(thread, { role: "bot", kind: "secret", text: "enter it", secret: { target: CUSTOM_SECRET_TARGET, label: "Share password", description: "", reason: "To open the share.", placeholder: "", helpUrl: "", requestKey: "k", delivery: "ref" } });
      expect(lifts.raise({ botId: bot.id, threadId: thread, requestMessageId: request.id, memoryChanged: false, outside: true })).toBe("open");
    };
    const allow = () => lifts.resolve(thread, store.messagesFor(thread).find((line) => line.card?.lendingLift)!.card!.requestId!, "allow");
    const runTimers = () => { while (timers.length) { at += 5_000; timers.shift()!(); } };
    return { store, bot, thread, task, continued, timers, turnRaisesCards, allow, runTimers, later: (ms: number) => { at += ms; } };
  }

  it("never shows a conversation resting on its cards working: the request goes on at once", () => {
    const { store, bot, thread, task, continued, turnRaisesCards, allow } = conversation();
    turnRaisesCards();
    store.setTaskActivity(bot.id, thread, "idle");
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
    expect(allow()).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
    expect(continued).toEqual([[bot.id, expect.stringContaining("Carry on"), expect.objectContaining({ threadId: thread, cardContinuation: true })]]);
  });

  it.each([
    ["the person stopped the conversation", { stopped: true }],
    ["the continuation can't start", { rejects: true }],
  ])("leaves nothing working when the request doesn't go on: %s", async (_why, options) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { store, bot, thread, task, turnRaisesCards, allow } = conversation(options);
      turnRaisesCards();
      store.setTaskActivity(bot.id, thread, "idle");
      allow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(task()).toMatchObject({ busy: false });
      expect(store.bot(bot.id)).toMatchObject({ busy: false });
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves nothing working when someone wrote since", () => {
    const { store, bot, thread, task, continued, turnRaisesCards, allow } = conversation();
    turnRaisesCards();
    store.setTaskActivity(bot.id, thread, "idle");
    store.appendMessage(thread, { role: "user", kind: "text", text: "Never mind" });
    allow();
    expect(task()).toMatchObject({ busy: false });
    expect(continued).toEqual([]);
  });

  it("a turn still running when they allow it goes back to working, and the request goes on once it ends", () => {
    const { store, bot, thread, task, continued, timers, turnRaisesCards, allow } = conversation();
    turnRaisesCards();
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: true });
    allow();
    expect(task()).toMatchObject({ activity: "working", busy: true });
    expect(continued).toEqual([]);
    store.setTaskActivity(bot.id, thread, "idle");
    timers.shift()!();
    expect(continued).toHaveLength(1);
  });

  it("gives up on a conversation that stays busy, which its own turn then frees", () => {
    const { store, bot, thread, task, continued, turnRaisesCards, allow, runTimers, later } = conversation();
    turnRaisesCards();
    allow();
    later(CARRY_ON_MS);
    runTimers();
    expect(continued).toEqual([]);
    store.setTaskActivity(bot.id, thread, "idle");
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
  });
});
