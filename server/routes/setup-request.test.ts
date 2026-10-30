// POST and DELETE /api/bots/:id/setup-request: a pick or Something else on the setup card, and the x on the card or chip.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import { openSetupOffer, setupTurnText, takeSetupRequest } from "../setup-request.ts";
import { Store } from "../store.ts";
import { createSetupRequestRoutes } from "./setup-request.ts";
import { PASS } from "./table.ts";

const person: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member = { kind: "session", scopes: ["client"], via: "bearer", session: { id: "s1" } } as unknown as RequestAuth;
const admin = { kind: "session", scopes: ["admin", "client"], via: "bearer", session: { id: "s2" } } as unknown as RequestAuth;

function setup(refusal: string | null = null, options: { canSetUp?: boolean; sendFails?: boolean; hold?: Promise<void> } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }), undefined, undefined, "en");
  const bot = store.createBot({ name: "Ava" });
  let presser: string | undefined;
  let auth = person;
  const sent: string[] = [];
  // As the messages route does: the person's line is stored, then its turn reads it as setup or as typed.
  const send = async (_auth: RequestAuth, botId: string, threadId: string, text: string) => {
    if (options.sendFails) throw Object.assign(new Error("Ava is busy."), { status: 409 });
    sent.push(text);
    await options.hold;
    const line = store.appendMessage(threadId, { role: "user", kind: "text", text });
    return { ok: true as const, message: takeSetupRequest(store, { botId, threadId, line, person: true, mounted: true }) ?? line };
  };
  const route = createSetupRequestRoutes({ store, language: () => "es", sendRefusal: () => refusal, presser: () => presser,
    canSetUp: () => options.canSetUp ?? true, send });
  const as = (who: string | undefined, caller: RequestAuth = member) => { presser = who; auth = caller; };
  const call = async (method: string, body: unknown, botId = bot.id, path = `/api/bots/${botId}/setup-request`) => {
    let answer: { status: number; body: any } | undefined;
    const handled = await route({ req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth,
      json: (_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }, readBody: async () => body } as never);
    return handled === PASS ? "pass" : answer!;
  };
  return { store, bot, call, as, sent, waiting: () => store.taskByThread(bot.id, bot.threadId)?.setupRequest };
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the Set me up route", () => {
  it("answers the press with the bot's line in the app's language and marks the conversation; a second press is a no-op", async () => {
    const s = setup();
    const pressed = await s.call("POST", { threadId: s.bot.threadId });
    expect(pressed).toMatchObject({ status: 200, body: { ok: true, message: { role: "bot", kind: "text", text: expect.stringMatching(/^Genial\./) } } });
    expect(s.waiting()).toBeDefined();
    expect(await s.call("POST", { threadId: s.bot.threadId })).toEqual({ status: 200, body: { ok: true, already: true } });
    expect(s.store.messagesFor(s.bot.threadId)).toHaveLength(2);
  });

  it("clears the mark on DELETE, and closes the card", async () => {
    const s = setup();
    await s.call("POST", { threadId: s.bot.threadId });
    expect(await s.call("DELETE", { threadId: s.bot.threadId })).toEqual({ status: 200, body: { ok: true } });
    expect(s.waiting()).toBeUndefined();
    expect(s.store.messagesFor(s.bot.threadId)[0]?.setupOffer).toBeUndefined();
    expect(await s.call("POST", { threadId: s.bot.threadId, text: "Research and digging into topics" })).toMatchObject({ status: 409 });
  });

  it("runs a pick at once: its words are sent as the person's line and read as setup, with no line from the bot", async () => {
    const s = setup();
    const picked = await s.call("POST", { threadId: s.bot.threadId, text: "  Research and digging into topics " });
    expect(picked).toMatchObject({ status: 200, body: { ok: true, message: { role: "user", text: "Research and digging into topics", setupRequest: true } } });
    expect(s.sent).toEqual(["Research and digging into topics"]);
    expect(setupTurnText(picked === "pass" ? ({} as never) : picked.body.message, false)).toBe("/setup Research and digging into topics");
    expect(s.store.messagesFor(s.bot.threadId).map((message) => message.role)).toEqual(["bot", "user"]);
    expect(s.waiting()).toBeUndefined();
    expect(await s.call("POST", { threadId: s.bot.threadId, text: "Data, spreadsheets and reports" })).toMatchObject({ status: 409 });
    expect(s.sent).toHaveLength(1);
  });

  it("sends one message for a double pick, a letter key during sending, or a second tab", async () => {
    let release!: () => void;
    const s = setup(null, { hold: new Promise<void>((resolve) => { release = resolve; }) });
    const first = s.call("POST", { threadId: s.bot.threadId, text: "Research and digging into topics" });
    await Promise.resolve();
    expect(await s.call("POST", { threadId: s.bot.threadId, text: "Research and digging into topics" })).toEqual({ status: 409, body: { error: "That answer is already on its way." } });
    expect(await s.call("POST", { threadId: s.bot.threadId })).toMatchObject({ status: 409 });
    release();
    expect(await first).toMatchObject({ status: 200 });
    expect(await s.call("POST", { threadId: s.bot.threadId, text: "Research and digging into topics" })).toMatchObject({ status: 409 });
    expect(s.sent).toEqual(["Research and digging into topics"]);
    expect(s.store.messagesFor(s.bot.threadId).filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("refuses a pick without words or with too many, and stops waiting, card still open, when the words cannot be sent", async () => {
    const s = setup();
    for (const text of ["", "   ", 7, "x".repeat(501)]) expect(await s.call("POST", { threadId: s.bot.threadId, text })).toMatchObject({ status: 400 });
    expect(s.waiting()).toBeUndefined();
    const busy = setup(null, { sendFails: true });
    expect(await busy.call("POST", { threadId: busy.bot.threadId, text: "Research and digging into topics" })).toEqual({ status: 409, body: { error: "Ava is busy." } });
    expect(busy.waiting()).toBeUndefined();
    expect(openSetupOffer(busy.store, busy.bot.id, busy.bot.threadId)).not.toBeNull();
  });

  it("refuses a bad body, an unknown bot or conversation, a set-up bot, and a caller who may not write there", async () => {
    const s = setup();
    expect(await s.call("POST", {})).toMatchObject({ status: 400 });
    expect(await s.call("POST", { threadId: "../x" })).toMatchObject({ status: 400 });
    expect(await s.call("POST", { threadId: s.bot.threadId }, "no-such-bot")).toMatchObject({ status: 404 });
    expect(await s.call("POST", { threadId: "other-thread" })).toMatchObject({ status: 404 });
    expect(await s.call("DELETE", { threadId: "other-thread" })).toMatchObject({ status: 404 });
    s.store.patchBot(s.bot.id, { soul: "Only water the garden." });
    expect(await s.call("POST", { threadId: s.bot.threadId })).toMatchObject({ status: 409 });
    const guest = setup("On this Cloud you can only write in conversations you started.");
    expect(await guest.call("POST", { threadId: guest.bot.threadId })).toMatchObject({ status: 403 });
    expect(await guest.call("DELETE", { threadId: guest.bot.threadId })).toMatchObject({ status: 403 });
    expect(guest.store.messagesFor(guest.bot.threadId)).toHaveLength(1);
  });

  it("records who pressed it where people share the place, and only they may close its chip", async () => {
    const s = setup();
    s.as("member-a");
    expect(await s.call("POST", { threadId: s.bot.threadId })).toMatchObject({ status: 200 });
    expect(s.waiting()).toMatchObject({ by: "member-a" });
    s.as("member-b");
    expect(await s.call("DELETE", { threadId: s.bot.threadId })).toEqual({
      status: 403, body: { error: "Only the person who pressed Set me up, or an owner or admin, can stop it." },
    });
    expect(s.waiting()).toBeDefined();
    s.as("member-a");
    expect(await s.call("DELETE", { threadId: s.bot.threadId })).toMatchObject({ status: 200 });
    expect(s.waiting()).toBeUndefined();
  });

  it("refuses another person's press while one waits, and lets an owner or admin clear it", async () => {
    const s = setup();
    s.as("member-a");
    expect(await s.call("POST", { threadId: s.bot.threadId })).toMatchObject({ status: 200 });
    s.as("owner", admin);
    expect(await s.call("POST", { threadId: s.bot.threadId })).toEqual({ status: 409, body: { error: "Someone else is setting this bot up." } });
    expect(await s.call("DELETE", { threadId: s.bot.threadId })).toEqual({ status: 200, body: { ok: true } });
    expect(s.waiting()).toBeUndefined();
  });

  it("refuses the press, in plain words, when the bot's AI cannot set it up", async () => {
    const s = setup(null, { canSetUp: false });
    expect(await s.call("POST", { threadId: s.bot.threadId })).toEqual({
      status: 409, body: { error: "This bot's AI can't set it up by itself. Tell the bot what you'd like it to do instead." },
    });
    expect(s.store.messagesFor(s.bot.threadId)).toHaveLength(1);
    expect(s.waiting()).toBeUndefined();
  });

  it("leaves other paths alone", async () => {
    const s = setup();
    expect(await s.call("GET", undefined)).toBe("pass");
    expect(await s.call("POST", {}, s.bot.id, `/api/bots/${s.bot.id}/messages`)).toBe("pass");
  });

  it("is open to anyone who may write to the bot, like sending a message", () => {
    for (const method of ["POST", "DELETE"]) expect(requiredScope(method, "/api/bots/x/setup-request")).toBe("client");
    expect(requiredScope("PUT", "/api/bots/x/setup-request")).toBe("admin");
  });
});
