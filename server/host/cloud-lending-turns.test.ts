import { describe, expect, it } from "vitest";
import { ONLY_THE_PERSON } from "../cloud-lending.ts";
import { createCloudLendingTurns } from "./cloud-lending-turns.ts";

const OWNER = "p_owner";
const turn = { botId: "b1", threadId: "t1", generation: "g1" };
const own = { id: "m1", role: "user", sender: { id: OWNER } };

function lending({ lines = [own] as Record<string, unknown>[], flagged = false, room = false, team = null as string | null, starter = undefined as string | undefined, openedBy = undefined as object | undefined } = {}) {
  const asked: string[] = [];
  const host = createCloudLendingTurns({
    store: {
      groupByThread: () => (room ? { threadId: "t1" } : undefined),
      messagesFor: () => lines,
      botByThread: () => ({ id: "b1" }),
      taskByThread: () => ({ threadId: "t1", ...(openedBy ? { openedBy } : {}) }),
    } as never,
    cloudHome: true, team,
    directRequest: () => ({ messageId: "m1", generations: new Set(["g1"]) }),
    threadStarter: () => starter,
    ownerPerson: (person) => person === OWNER,
    cardAnswerer: () => undefined,
    activeRoutineRun: () => null,
    ownerStartedRun: () => false,
    routineRunIsOwners: () => false,
    memoryChangedBySomeoneElse: (botId) => { asked.push(botId); return flagged; },
    routines: () => null,
    routineAuthors: null,
    lentPlatform: () => "darwin",
  });
  if (room) host.roomTurnStarted("g1", { requestMessageId: "m1", cancelled: false } as never);
  return { host, asked };
}

const handedIn = { id: "m1", role: "user", peerAsk: { botId: "b2" } };
const webhookPost = { id: "w1", role: "bot", webhookPost: true };

describe("what a turn hears when it can't use the lent Mac (server/host/cloud-lending-turns.ts)", () => {
  it("a turn every gate allows hears nothing", () => {
    const { host } = lending();
    expect(host.cloudLendingRefusal(turn)).toBeNull();
    expect(host.cloudLendingRefusalNotice(turn)).toBeNull();
    expect(host.cloudLendingRefusalForBot(turn)).toBeNull();
  });
  it("a locked bot's memory is checked even when the conversation is refused already", () => {
    const { host, asked } = lending({ lines: [handedIn] });
    expect(host.cloudLendingRefusal(turn)).toBe("not-owner");
    expect(asked).toEqual(["b1"]);
  });
  it("the owner's own clean conversation on a locked bot is told only about Memory, never a new conversation", () => {
    const { host } = lending({ flagged: true });
    expect(host.cloudLendingRefusal(turn)).toBe("memory-changed");
    const notice = host.cloudLendingRefusalNotice(turn)!;
    expect(notice).toContain("tap Mark reviewed, then ask again here.");
    expect(notice).not.toMatch(/new conversation|new thread/iu);
  });
  it("with two gates shut it names both steps, in the order that works", () => {
    const direct = lending({ flagged: true, lines: [handedIn] }).host;
    expect(direct.cloudLendingRefusal(turn)).toBe("memory-changed-here");
    expect(direct.cloudLendingRefusalNotice(turn)).toContain("tap Mark reviewed, then start a new conversation with this bot and ask there.");
    const webhook = lending({ flagged: true, lines: [own, webhookPost] }).host;
    expect(webhook.cloudLendingRefusalNotice(turn)).toContain("tap Mark reviewed, then start a new conversation with this bot and ask there.");
    const room = lending({ flagged: true, room: true, lines: [own, { id: "m2", role: "user", sender: { id: "p_other" } }] }).host;
    expect(room.cloudLendingRefusalNotice(turn)).toContain("tap Mark reviewed, then start a new thread in this group chat and ask there.");
    for (const host of [direct, webhook, room]) expect(host.cloudLendingRefusalNotice(turn)).not.toMatch(/^Start|\. Start a new/u);
  });
  it("his own line in a webhook's thread is told a webhook posted there, not that someone else wrote", () => {
    const { host } = lending({ lines: [own, webhookPost] });
    expect(host.cloudLendingRefusal(turn)).toBe("someone-else");
    expect(host.cloudLendingRefusalNotice(turn)).toBe("A webhook or a routine you didn't write posted in this conversation, so it can't use your Mac. Start a new conversation with this bot to use it.");
  });
  it("his own line in a conversation a bot opened is refused, and told so; the same judge keeps it out of what feeds memory", () => {
    const { host } = lending({ openedBy: { botId: "b2", name: "CoS", kind: "work", at: 1 } });
    expect(host.cloudBotOpened("t1")).toBe(true);
    expect(host.cloudLendingRefusal(turn)).toBe("someone-else");
    expect(host.cloudLendingRefusalNotice(turn)).toBe("A bot opened this conversation, so it can't use your Mac. Start a new conversation with this bot to use it.");
    expect(host.cloudLendingView(turn)).toBe(false);
    expect(lending().host.cloudBotOpened("t1")).toBe(false);
  });
  it("another person's line still says so", () => {
    const { host } = lending({ lines: [own, { id: "m2", role: "user", sender: { id: "p_other", name: "Other" } }, webhookPost] });
    expect(host.cloudLendingRefusalNotice(turn)).toContain("Someone else wrote in this conversation");
  });
  it("a refused call tells the bot to stop; the person's words stay apart", () => {
    const { host } = lending({ lines: [handedIn] });
    const notice = host.cloudLendingRefusalNotice(turn)!;
    expect(notice).not.toContain(ONLY_THE_PERSON);
    expect(host.cloudLendingRefusalForBot(turn)).toBe(`${notice} ${ONLY_THE_PERSON}`);
    expect(ONLY_THE_PERSON).toMatch(/end your turn/u);
    expect(ONLY_THE_PERSON).toMatch(/a conversation you open yourself/u);
    expect(ONLY_THE_PERSON).toMatch(/another bot/u);
  });
  it("on a team the bots have a computer to use, so nothing tells them to stop", () => {
    const { host } = lending({ team: "Acme", lines: [handedIn] });
    expect(host.cloudLendingRefusalForBot(turn)).toBe("Acme's bots never use anyone's own computer; they use Acme's cloud computer.");
  });
});

describe("a card lifts a lock only for the owner's own line (server/host/cloud-lending-turns.ts)", () => {
  function withLifts(lines: Record<string, unknown>[], { flagged = false, allowedAt = -1, declined = false, directRequest = { messageId: "m1", generations: new Set(["g1"]) } as Record<string, unknown>, ownersRun = false, botOpened = false, handed = false } = {}) {
    const raised: unknown[] = [];
    const run = { id: "r1", threadId: "t1", routineId: "rt1", triggerSource: "manual" };
    const host = createCloudLendingTurns({
      store: { groupByThread: () => undefined, messagesFor: () => lines, botByThread: () => ({ id: "b1" }), taskByThread: () => ({ threadId: "t1", ...(ownersRun ? { routineRunId: "r1" } : {}), ...(botOpened ? { openedBy: { botId: "b2", name: "CoS", kind: "work", at: 1 } } : {}) }) } as never,
      cloudHome: true, team: null, directRequest: () => directRequest as never, threadStarter: () => undefined, ownerPerson: (person) => person === OWNER, cardAnswerer: (card) => card.answeredBy?.person,
      activeRoutineRun: () => (ownersRun ? run as never : null), ownerStartedRun: () => ownersRun, routineRunIsOwners: () => ownersRun, memoryChangedBySomeoneElse: () => flagged, routines: () => null, routineAuthors: null, lentPlatform: () => "darwin",
      lifts: () => ({ raise: (input) => { raised.push(input); return "open" as const; }, declined: () => declined, outsideAllowed: () => (allowedAt < 0 ? null : { index: allowedAt, at: 100 }) }),
      handedSince: (_, since) => { expect(since).toBe(100); return handed; },
    });
    return { host, raised };
  }
  it("his own line on a locked bot raises one for what's shut, and he's told about the card", () => {
    const { host, raised } = withLifts([own], { flagged: true });
    expect(host.cloudLendingRefusalNotice(turn)).toBe("This bot's memory was changed in a conversation you didn't write, so it can't use your Mac until you allow it on the card in this chat.");
    expect(host.cloudLendingRefusalForBot(turn)).toContain("End your turn and say in one line that you're waiting for them");
    expect(raised).toEqual([{ botId: "b1", threadId: "t1", requestMessageId: "m1", memoryChanged: true, outside: false, botOpened: false }]);
  });
  it("his own line in a webhook's thread raises one for that", () => {
    const { host, raised } = withLifts([own, webhookPost]);
    host.cloudLendingRefusalForBot(turn);
    expect(raised).toEqual([{ botId: "b1", threadId: "t1", requestMessageId: "m1", memoryChanged: false, outside: true, botOpened: false }]);
  });
  it("a webhook's own run raises none and stays barred, whatever he allowed for his line", () => {
    const run = { messageId: "m1", generations: new Set(["g1"]), automation: "webhook" };
    const { host, raised } = withLifts([own, webhookPost], { directRequest: run, allowedAt: 1 });
    expect(host.cloudLendingRefusal(turn)).toBe("not-owner");
    expect(host.cloudLendingRefusalForBot(turn)).toContain("Only the person can change this");
    expect(raised).toEqual([]);
  });
  it("a run of his own routine raises none, even one he started whose line carries his name: only a line he wrote now does", () => {
    const { host, raised } = withLifts([own], { flagged: true, ownersRun: true, directRequest: { messageId: "m1", generations: new Set(["g1"]), automation: "manual" } });
    expect(host.cloudLendingRefusal(turn)).toBe("memory-changed");
    expect(host.cloudLendingRefusalNotice(turn)).toContain("tap Mark reviewed, then ask again here.");
    expect(host.cloudLendingRefusalForBot(turn)).toContain("Only the person can change this");
    expect(raised).toEqual([]);
  });
  it("his own line in a conversation a bot opened raises one for that, and he's told about the card", () => {
    const { host, raised } = withLifts([own], { botOpened: true });
    expect(host.cloudLendingRefusal(turn)).toBe("someone-else");
    expect(host.cloudLendingRefusalNotice(turn)).toBe("A bot opened this conversation, so it can't use your Mac until you allow it on the card in this chat.");
    host.cloudLendingRefusalForBot(turn);
    expect(raised).toEqual([{ botId: "b1", threadId: "t1", requestMessageId: "m1", memoryChanged: false, outside: true, botOpened: true }]);
  });
  it("once he allowed it, the same judge lets that line through, until a bot hands in more work or a webhook posts", () => {
    const allowed = { id: "c1", role: "bot", card: { requestId: "q1", answered: "allow", answeredBy: { kind: "session", person: OWNER } } };
    expect(withLifts([own, allowed], { botOpened: true, allowedAt: 1 }).host.cloudLendingRefusal(turn)).toBeNull();
    expect(withLifts([own, allowed], { botOpened: true, allowedAt: 1 }).host.cloudLendingView(turn)).toBe(true);
    expect(withLifts([own, allowed], { botOpened: true }).host.cloudLendingRefusal(turn)).toBe("someone-else");
    expect(withLifts([own, allowed], { botOpened: true, allowedAt: 1, handed: true }).host.cloudLendingRefusal(turn)).toBe("someone-else");
    expect(withLifts([own, allowed, webhookPost], { botOpened: true, allowedAt: 1 }).host.cloudLendingRefusal(turn)).toBe("someone-else");
  });
  it("a conversation a bot opened that another person wrote in, or a line a bot handed into it, raises none", () => {
    const withOther = withLifts([own, { id: "m2", role: "user", sender: { id: "p_other", name: "Other" } }], { botOpened: true });
    withOther.host.cloudLendingRefusalForBot(turn);
    expect(withOther.raised).toEqual([]);
    const handedLine = withLifts([handedIn], { botOpened: true });
    expect(handedLine.host.cloudLendingRefusalForBot(turn)).toContain("Only the person can change this");
    expect(handedLine.raised).toEqual([]);
  });
  it("a line a bot handed in raises none", () => {
    const { host, raised } = withLifts([handedIn], { flagged: true });
    expect(host.cloudLendingRefusalForBot(turn)).toContain("Only the person can change this");
    expect(raised).toEqual([]);
  });
  it("another person's words are never lifted, even on his own line beside a webhook's post", () => {
    const { host, raised } = withLifts([own, webhookPost, { id: "m2", role: "user", sender: { id: "p_other", name: "Other" } }], { allowedAt: 1 });
    expect(host.cloudLendingRefusal(turn)).toBe("someone-else");
    host.cloudLendingRefusalForBot(turn);
    expect(raised).toEqual([]);
  });
  it("what he allowed lets the same judge through; a post after that, or anyone else's answer, shuts it again", () => {
    const allowed = { id: "c1", role: "bot", card: { requestId: "q1", answered: "allow", answeredBy: { kind: "session", person: OWNER } } };
    expect(withLifts([webhookPost, own, allowed], { allowedAt: 2 }).host.cloudLendingRefusal(turn)).toBeNull();
    expect(withLifts([webhookPost, own, allowed]).host.cloudLendingRefusal(turn)).toBe("someone-else");
    expect(withLifts([webhookPost, own, allowed, webhookPost], { allowedAt: 2 }).host.cloudLendingRefusal(turn)).toBe("someone-else");
    const notHis = { id: "c1", role: "bot", card: { requestId: "q1", answered: "allow", answeredBy: { kind: "session", person: "p_other" } } };
    expect(withLifts([webhookPost, own, notHis], { allowedAt: 2 }).host.cloudLendingRefusal(turn)).toBe("someone-else");
  });
  it("after Not now the card isn't raised again for that line, and the settings way is named", () => {
    const { host, raised } = withLifts([own], { flagged: true, declined: true });
    expect(host.cloudLendingRefusalNotice(turn)).toContain("tap Mark reviewed, then ask again here.");
    expect(host.cloudLendingRefusalForBot(turn)).toContain("Only the person can change this");
    expect(raised).toEqual([]);
  });
  it("what's let through for the Mac still reads only the owner's conversations", () => {
    const allowed = { id: "c1", role: "bot", card: { requestId: "q1", answered: "allow", answeredBy: { kind: "session", person: OWNER } } };
    expect(withLifts([webhookPost, own, allowed], { allowedAt: 2 }).host.cloudLendingView(turn)).toBe(true);
    expect(withLifts([webhookPost, own, allowed]).host.cloudLendingView(turn)).toBe(false);
  });
});

describe("a routine someone else changed (email 1a1bca40)", () => {
  const routinePrompt = { id: "m1", role: "user", automation: { routineId: "r1" } };
  function routineRun({ trigger = "schedule" as "schedule" | "manual" | "webhook" | "startup", ownerStarted = false, ownerAuthored = false, flagged = false } = {}) {
    const run = { id: "run1", routineId: "r1", threadId: "t1", triggerSource: trigger };
    return createCloudLendingTurns({
      store: {
        groupByThread: () => undefined,
        messagesFor: () => [routinePrompt],
        botByThread: () => ({ id: "b1" }),
        taskByThread: () => ({ threadId: "t1", routineRunId: "run1" }),
      } as never,
      cloudHome: true,
      directRequest: () => ({ messageId: "m1", generations: new Set(["g1"]), automation: trigger }),
      threadStarter: () => undefined,
      ownerPerson: (person) => person === OWNER,
      cardAnswerer: () => undefined,
      activeRoutineRun: () => run as never,
      ownerStartedRun: () => ownerStarted,
      routineRunIsOwners: () => ownerAuthored,
      memoryChangedBySomeoneElse: () => flagged,
      routines: () => ({ listRoutines: () => [{ id: "r1", name: "Morning inbox" }] }) as never,
      routineAuthors: { authored: () => ownerAuthored },
      lentPlatform: () => "darwin",
    });
  }
  const changed = "\"Morning inbox\" can't use your Mac because it isn't confirmed as yours: it was last changed or made outside your own chats. Open it and save it to make it yours again.";

  it("its scheduled run is told, by name, how to make it theirs again", () => {
    const host = routineRun();
    expect(host.cloudLendingRefusal(turn)).toBe("not-owner");
    expect(host.cloudLendingRefusalNotice(turn)).toBe(changed);
    expect(host.cloudLendingRefusalForBot(turn)).toBe(`${changed} ${ONLY_THE_PERSON}`);
    expect(routineRun({ trigger: "startup" }).cloudLendingRefusalNotice(turn)).toBe(changed);
    expect(routineRun({ trigger: "manual", ownerStarted: true }).cloudLendingRefusalNotice(turn)).toBe(changed);
  });
  it("the owner's own routine still runs, and every other refusal keeps its words", () => {
    expect(routineRun({ ownerAuthored: true }).cloudLendingRefusalNotice(turn)).toBeNull();
    for (const host of [routineRun({ trigger: "webhook" }), routineRun({ trigger: "manual" }), routineRun({ flagged: true })]) {
      expect(host.cloudLendingRefusalNotice(turn)).not.toBeNull();
      expect(host.cloudLendingRefusalNotice(turn)).not.toContain("isn't confirmed as yours");
    }
  });
});
