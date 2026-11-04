import { describe, expect, it, vi } from "vitest";
import { parseOptionsCardInput } from "../../shared/options-card.ts";
import { liveDecisionRefusal } from "../../shared/live-approval.ts";
import { createLendingLifts, type LendingLiftDeps } from "./lending-lifts.ts";

const OWNER = "p_owner";

type Line = { id: string; role: string; kind?: string; card?: any; tool?: { name: string }; text?: string };

function world({ room = false, busy = false, owners = true, stopped = false } = {}) {
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
    now: () => 0,
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
    expect(lifts.outsideAllowedAt("t1", "u1")).toBe(-1);
    expect(cardOf(lines).subtitle).toContain("Allow lets only this message of yours use your Mac.");
    answer(cardOf(lines).requestId, "allow");
    expect(lifts.outsideAllowedAt("t1", "u1")).toBe(lines.findIndex((line) => line.card?.lendingLift));
    expect(lifts.outsideAllowedAt("t1", "u2")).toBe(-1);
    expect(lifts.outsideAllowedAt("t1", undefined)).toBe(-1);
  });
  it("a memory card allows nothing from outside", () => {
    const { lines, lifts, answer } = world();
    lifts.raise(input);
    answer(cardOf(lines).requestId, "allow");
    expect(lifts.outsideAllowedAt("t1", "u1")).toBe(-1);
  });
  it("only the owner's own answer lets outside words through, read from the card as it is now", () => {
    for (const answeredBy of [{ kind: "bot", person: undefined }, { kind: "session", person: "p_guest" }, { kind: "loopback" }, undefined]) {
      const { lines, lifts } = world();
      lines.push({ id: "w1", role: "bot", card: { requestId: "lending-lift-forged", answered: "allow", ...(answeredBy ? { answeredBy } : {}), lendingLift: { requestMessageId: "u1", outside: true } } });
      expect(lifts.outsideAllowedAt("t1", "u1"), JSON.stringify(answeredBy)).toBe(-1);
    }
  });
  it("another person, a process on the machine or a bot can't answer it", () => {
    for (const person of ["p_guest", null]) {
      const { lines, state, lifts, answer } = world();
      lifts.raise({ ...input, outside: true });
      expect(answer(cardOf(lines).requestId, "allow", person)!.status).toBe(403);
      expect(cardOf(lines).answered).toBeUndefined();
      expect(state.accepted).toEqual([]);
      expect(lifts.outsideAllowedAt("t1", "u1")).toBe(-1);
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
  it("answers only its own cards", () => {
    expect(world().answer("something-else", "allow")).toBeNull();
  });
});
