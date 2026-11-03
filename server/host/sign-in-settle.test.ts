import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, Message } from "../store.ts";
import { createSignInSettle, signInChatPrompt, type SignInSettleDeps } from "./sign-in-settle.ts";

function world(parked?: Partial<HandoffView>) {
  let rows: Message[] = [];
  let ids = 0;
  const add = (message: Partial<Message>) => { const full = { id: `m${++ids}`, at: 1_000 + ids, role: "bot", ...message } as Message; rows.push(full); return full; };
  const answered: Array<{ messageId: string; text: string }> = [];
  const released: string[] = [];
  const handedBack: string[] = [];
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
    settleHelp: () => [],
    handBackBrowser: (_bot, threadId) => { handedBack.push(threadId); },
    releaseComputer: () => {},
    computerKey: () => "computer",
  };
  return { settle: createSignInSettle(deps), add, rows: () => rows, answered, released, handedBack };
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
