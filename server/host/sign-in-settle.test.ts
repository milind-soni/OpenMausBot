import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, Message } from "../store.ts";
import { createSignInSettle, signInChatPrompt, type SignInSettleDeps } from "./sign-in-settle.ts";

function world(parked?: Partial<HandoffView>, pleas = new Map<string, string[]>()) {
  let rows: Message[] = [];
  let ids = 0;
  const add = (message: Partial<Message>) => { const full = { id: `m${++ids}`, at: 1_000 + ids, role: "bot", ...message } as Message; rows.push(full); return full; };
  const answered: Array<{ messageId: string; text: string }> = [];
  const released: string[] = [];
  const handedBack: string[] = [];
  const handedBackKeys: string[] = [];
  const node = parked ? { id: "as_1", threadId: "work", botId: "dachs", status: "waiting", createdAt: 1_000, ...parked } as HandoffView : undefined;
  const deps: SignInSettleDeps = {
    store: {
      activePath: () => rows,
      bot: (id: string) => ({ id, name: "Dachs" }) as BotRecord,
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row)); return null; },
    } as unknown as SignInSettleDeps["store"],
    signInMessage: (_botId, _threadId, messageId) => rows.find((row) => row.id === messageId) ?? null,
    answerCardNode: (_threadId, messageId, text) => { answered.push({ messageId, text }); return true; },
    releaseCardNode: (_threadId, messageId) => { released.push(messageId); },
    resumableCards: () => [],
    parkedDirect: () => node,
    settleHelp: (messageId) => [...pleas].filter(([, cards]) => cards.includes(messageId)).map(([key, cards]) => {
      pleas.set(key, cards.filter((id) => id !== messageId));
      return key;
    }),
    handBackBrowser: (_bot, threadId) => { handedBack.push(threadId); },
    releaseComputer: (key) => { handedBackKeys.push(key); },
    computerKey: (bot, threadId) => `${bot.id}/${threadId}`,
    sharedKey: (key) => key.startsWith("computer_"),
    pleas: (key) => (pleas.get(key) ?? []).map((messageId) => ({ botId: "dachs", threadId: "work", messageId, site: "notion.so", place: "vm" })),
  };
  return { settle: createSignInSettle(deps), add, rows: () => rows, answered, released, handedBack, handedBackKeys };
}

const card = (site = "notion.so") => ({ kind: "signin" as const, text: `Sign in to ${site}`, signIn: { url: `https://${site}`, site, place: "browser" as const } });

describe("a sign-in the person answers in the chat", () => {
  it("carries work handed on along with the person's line, instead of leaving it parked", () => {
    const w = world({ parentId: "root", cards: ["m1"] });
    w.add(card());
    expect(w.settle.answerInChat("dachs", "work", "Bin angemeldet")).toBe(true);
    expect(w.answered).toEqual([{ messageId: "m1", text: signInChatPrompt("notion.so", "Bin angemeldet") }]);
    expect(w.released).toEqual([]);
    expect(w.rows()[0]!.signIn).toMatchObject({ answeredInChat: true });
    expect(w.handedBack).toEqual(["work"]);
  });

  it("ends a person's own parked conversation, which goes on with the turn their line starts", () => {
    const w = world({ cards: ["m1"] });
    w.add(card());
    expect(w.settle.answerInChat("dachs", "work", "Bin angemeldet")).toBe(false);
    expect(w.released).toEqual(["m1"]);
    expect(w.answered).toEqual([]);
  });
});

describe("a sign-in settled without the person pressing Done", () => {
  it("settles the cards work waits on when another bot passes on an answer", () => {
    const w = world();
    w.add(card());
    w.add(card("github.com"));
    w.settle.answeredElsewhere({ id: "as_1", threadId: "work", botId: "dachs", cards: ["m2"] } as HandoffView);
    expect(w.rows().map((row) => row.signIn?.answeredInChat ?? false)).toEqual([false, true]);
  });

  it("is done once the bot goes on with that site in the same turn, and keeps waiting otherwise", () => {
    const w = world();
    w.add(card());
    w.add({ kind: "activity", tool: { name: "browser_open", ok: true, input: JSON.stringify({ url: "https://www.notion.so/workspace" }) } });
    w.add(card("github.com"));
    w.add({ kind: "activity", tool: { name: "browser_open", ok: false, input: JSON.stringify({ url: "https://github.com/login" }) } });
    w.settle.verified("dachs", "work", 0);
    expect(w.rows().filter((row) => row.signIn).map((row) => [row.signIn!.site, row.signIn!.done ?? false])).toEqual([["notion.so", true], ["github.com", false]]);
  });
});

describe("the computer a sign-in card lent the person", () => {
  type Path = "done" | "cancelled" | "answered in chat" | "answered elsewhere" | "verified";
  const handsBack = (path: Path, key: string, otherPlea: boolean): boolean => {
    const w = world(undefined, new Map([[key, ["m1", ...(otherPlea ? ["m2"] : [])]]]));
    w.add({ ...card(), signIn: { ...card().signIn, place: "vm" } });
    if (otherPlea) w.add({ ...card("figma.com"), signIn: { ...card("figma.com").signIn, place: "vm" } });
    if (path === "done" || path === "cancelled") w.settle.settle("dachs", "work", "m1", path);
    if (path === "answered in chat") w.settle.answerInChat("dachs", "work", "Bin angemeldet");
    if (path === "answered elsewhere") w.settle.answeredElsewhere({ id: "as_1", threadId: "work", botId: "dachs", cards: ["m1"] } as HandoffView);
    if (path === "verified") {
      w.add({ kind: "activity", tool: { name: "browser_open", ok: true, input: JSON.stringify({ url: "https://www.notion.so/workspace" }) } });
      w.settle.verified("dachs", "work", 0);
    }
    return w.handedBackKeys.includes(key);
  };

  it("goes back from the card's own conversation when no plea of it is left, as after a restart", () => {
    const w = world();
    w.add({ ...card(), signIn: { ...card().signIn, place: "vm" } });
    w.settle.settle("dachs", "work", "m1", "done");
    expect(w.handedBackKeys).toEqual(["dachs/work"]);
    const answered = world();
    answered.add({ ...card(), signIn: { ...card().signIn, place: "vm" } });
    answered.settle.answerInChat("dachs", "work", "Bin angemeldet");
    expect(answered.handedBackKeys).toEqual(["dachs/work"]);
  });

  it("goes back on every path when it is the bot's own, and a shared one only when the person settles its last plea", () => {
    const paths: Path[] = ["done", "cancelled", "answered in chat", "answered elsewhere", "verified"];
    expect(paths.map((path) => [path, handsBack(path, "dachs", false), handsBack(path, "dachs", true), handsBack(path, "computer_team", false), handsBack(path, "computer_team", true)])).toEqual([
      ["done", true, true, true, false],
      ["cancelled", true, true, true, false],
      ["answered in chat", true, true, false, false],
      ["answered elsewhere", true, true, false, false],
      ["verified", true, true, false, false],
    ]);
  });

  it("on the person's Done or Cancel also goes back from where the conversation works now, as after a move", () => {
    const released = (path: Path) => {
      const w = world(undefined, new Map([["computer_team", ["m1"]]]));
      w.add({ ...card(), signIn: { ...card().signIn, place: "vm" } });
      if (path === "done" || path === "cancelled") w.settle.settle("dachs", "work", "m1", path);
      if (path === "answered in chat") w.settle.answerInChat("dachs", "work", "Bin angemeldet");
      return w.handedBackKeys;
    };
    expect([released("done"), released("cancelled"), released("answered in chat")]).toEqual([
      ["computer_team", "dachs/work"],
      ["computer_team", "dachs/work"],
      [],
    ]);
  });
});
