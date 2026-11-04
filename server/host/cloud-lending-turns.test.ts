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
