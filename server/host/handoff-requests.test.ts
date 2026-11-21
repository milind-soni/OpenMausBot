import { describe, expect, it } from "vitest";

import { handoffResumePrompt, HANDOFF_EXPIRY_MS, signInOutcome } from "../../shared/sign-in-request.ts";
import type { ComputerHelpRef } from "../../shared/wire.ts";
import type { BotRecord, Message } from "../store.ts";
import { createHandoffRequests, handoffPlace, type HandoffRequestDeps } from "./handoff-requests.ts";
import { createSignInSettle, type SignInSettleDeps } from "./sign-in-settle.ts";

const BOT = { id: "dachs", name: "Dachs", color: "teal", browser: true } as unknown as BotRecord;

/** One conversation's rows behind both halves: the request that makes the card and the settle that ends it. */
function world(options: { place?: "browser" | "vm" | null; page?: string | null; rows?: Message[]; start?: number } = {}) {
  let rows: Message[] = options.rows ?? [];
  let ids = rows.length;
  let clock = options.start ?? 1_000_000;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const answered: Array<{ messageId: string; text: string }> = [];
  const helped: ComputerHelpRef[] = [];
  const handedBack: string[] = [];
  const store = {
    activePath: () => rows,
    bot: () => BOT,
    appendMessage: (_threadId: string, message: Partial<Message>) => { const full = { id: `m${++ids}`, at: clock, ...message } as Message; rows = [...rows, full]; return full; },
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row)); return null; },
  };
  const settle = createSignInSettle({
    store: store as unknown as SignInSettleDeps["store"],
    signInMessage: (_botId, _threadId, messageId) => rows.find((row) => row.id === messageId) ?? null,
    answerCardNode: (_threadId, messageId, text) => { answered.push({ messageId, text }); return true; },
    releaseCardNode: () => {}, resumableCards: () => [], parkedDirect: () => undefined, settleHelp: () => [],
    handBackBrowser: (_bot, threadId) => { handedBack.push(threadId); },
    releaseComputer: (key) => { handedBack.push(key); }, computerKey: (bot, threadId) => `${bot.id}/${threadId}`, sharedKey: () => false, pleas: () => [],
  });
  const deps: HandoffRequestDeps = {
    store: store as unknown as HandoffRequestDeps["store"],
    owner: () => ({}),
    place: () => options.place === undefined ? "browser" : options.place,
    computer: () => "vm",
    browserOn: () => true,
    pageNow: async () => options.page === undefined ? "github.com" : options.page,
    cardText: (name, site) => `${name} asks you to sign in to ${site}`,
    supersede: (threadId, prior) => { store.patchMessage(threadId, prior.id, { signIn: { ...prior.signIn!, superseded: true } }); },
    requestHelp: (_bot, _threadId, _place, _reason, ref) => { helped.push(ref); },
    expire: (botId, threadId, messageId) => { settle.expire(botId, threadId, messageId); },
    threadsWithCards: () => ["work"],
    botOf: () => BOT.id,
    now: () => clock,
    setTimer: (run, ms) => { const timer = { at: clock + ms, run, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true; } }; },
  };
  const requests = createHandoffRequests(deps);
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((one) => !one.cancelled && one.at <= clock)) { timer.cancelled = true; timer.run(); }
  };
  return { requests, settle, rows: () => rows, answered, helped, handedBack, advance };
}

const ask = { instruction: "Sign in to GitHub on the open page.", kind: "sign_in", target: "browser" };

describe("a bot hands one step to the person", () => {
  it("makes a pending card tied to the conversation, with the bot's page and a 30-minute expiry", async () => {
    const w = world();
    const made = await w.requests.request(BOT, "work", ask);
    expect(made).toMatchObject({ messageId: "m1", site: "github.com", place: "browser", instruction: ask.instruction, expiresAt: 1_000_000 + HANDOFF_EXPIRY_MS });
    expect(w.rows()[0]).toMatchObject({ kind: "signin", text: ask.instruction });
    expect(w.rows()[0]!.signIn).toMatchObject({ instruction: ask.instruction, need: "sign_in", site: "github.com", url: "https://github.com/", place: "browser" });
    expect(w.helped).toEqual([{ botId: "dachs", threadId: "work", messageId: "m1", site: "github.com", place: "browser", instruction: ask.instruction }]);
    expect(signInOutcome(w.rows()[0]!.signIn!)).toBeNull();
  });

  it("works without a page: an empty site, and kind defaults to other", async () => {
    const w = world({ page: null });
    await w.requests.request(BOT, "work", { instruction: "Approve the transfer in the bank's app." });
    expect(w.rows()[0]!.signIn).toMatchObject({ site: "", url: "", need: "other" });
  });

  it("stacks handoffs instead of replacing the open one", async () => {
    const w = world();
    await w.requests.request(BOT, "work", ask);
    await w.requests.request(BOT, "work", { ...ask, instruction: "Solve the CAPTCHA.", kind: "captcha" });
    expect(w.rows().map((row) => row.signIn?.superseded ?? false)).toEqual([false, false]);
  });

  it("still lets a site sign-in replace the open one for its site", async () => {
    const w = world();
    await w.requests.request(BOT, "work", { site: "notion.so" });
    await w.requests.request(BOT, "work", { site: "notion.so" });
    expect(w.rows().map((row) => row.signIn?.superseded ?? false)).toEqual([true, false]);
    expect(w.rows()[1]!.signIn!.expiresAt).toBeUndefined();
  });

  it("refuses a bad kind or target, and a computer when there is none", async () => {
    const w = world();
    await expect(w.requests.request(BOT, "work", { ...ask, kind: "pay" })).resolves.toMatchObject({ status: 400 });
    await expect(w.requests.request(BOT, "work", { ...ask, target: "phone" })).resolves.toMatchObject({ status: 400 });
    expect(handoffPlace("computer", "browser", null, true)).toBeNull();
    expect(handoffPlace("computer", "browser", "cloud", true)).toBe("cloud");
    expect(handoffPlace("browser", "vm", "vm", false)).toBeNull();
    expect(handoffPlace(undefined, "vm", null, true)).toBe("vm");
  });

  it("Done resumes the bot with the person's note and a request to check the page", async () => {
    const w = world();
    await w.requests.request(BOT, "work", ask);
    expect(w.settle.settle("dachs", "work", "m1", "done", undefined, "  Used the work account\n")).toMatchObject({ status: 200 });
    const card = w.rows()[0]!.signIn!;
    expect(card).toMatchObject({ done: true, note: "Used the work account", resumed: true });
    expect(w.answered).toEqual([{ messageId: "m1", text: handoffResumePrompt({ instruction: ask.instruction, note: "Used the work account" }, "done") }]);
    expect(w.answered[0]!.text).toContain("outcome done");
    expect(w.answered[0]!.text).toContain("That is their claim and is unverified.");
    expect(w.answered[0]!.text).toContain("Re-read the page");
    expect(w.handedBack).toEqual(["work"]);
  });

  it("tells done, skipped and expired apart, and only done is a claim to check", () => {
    const texts = (["done", "cancelled", "expired"] as const).map((outcome) => handoffResumePrompt({ instruction: ask.instruction }, outcome));
    expect(new Set(texts).size).toBe(3);
    expect(texts.map((text) => /outcome (done|skipped|expired)/.exec(text)?.[1])).toEqual(["done", "skipped", "expired"]);
    expect(texts.map((text) => text.includes("unverified"))).toEqual([true, false, false]);
    expect(texts.every((text) => text.includes("Re-read the page first"))).toBe(true);
  });

  it("Skip resumes the bot with skipped", async () => {
    const w = world();
    await w.requests.request(BOT, "work", ask);
    w.settle.settle("dachs", "work", "m1", "cancelled");
    expect(signInOutcome(w.rows()[0]!.signIn!)).toBe("cancelled");
    expect(w.answered[0]!.text).toContain("outcome skipped");
  });

  it("expires after 30 minutes: the place goes back, the bot is told, and a late Done is refused", async () => {
    const w = world();
    await w.requests.request(BOT, "work", ask);
    w.advance(HANDOFF_EXPIRY_MS - 1);
    expect(w.answered).toEqual([]);
    w.advance(1);
    expect(signInOutcome(w.rows()[0]!.signIn!)).toBe("expired");
    expect(w.answered).toEqual([{ messageId: "m1", text: handoffResumePrompt({ instruction: ask.instruction }, "expired") }]);
    expect(w.handedBack).toEqual(["work"]);
    expect(w.settle.settle("dachs", "work", "m1", "done")).toMatchObject({ status: 409 });
  });

  it("a card answered before its time does not expire later", async () => {
    const w = world();
    await w.requests.request(BOT, "work", ask);
    w.settle.settle("dachs", "work", "m1", "done");
    w.advance(HANDOFF_EXPIRY_MS);
    expect(w.answered).toHaveLength(1);
    expect(w.rows()[0]!.signIn!.expired).toBeUndefined();
  });

  it("an open handoff outlives a restart: it is timed again, and one already past its time ends at boot", async () => {
    const before = world();
    await before.requests.request(BOT, "work", ask);
    await before.requests.request(BOT, "work", { ...ask, instruction: "Solve the CAPTCHA." });
    const saved = before.rows().map((row, index) => index === 0 ? { ...row, signIn: { ...row.signIn!, expiresAt: 1_000_000 + 60_000 } } : row);
    const after = world({ rows: saved, start: 1_000_000 + 120_000 });
    after.requests.boot();
    after.advance(0);
    expect(after.rows().map((row) => signInOutcome(row.signIn!))).toEqual(["expired", null]);
    after.advance(HANDOFF_EXPIRY_MS);
    expect(after.rows().map((row) => signInOutcome(row.signIn!))).toEqual(["expired", "expired"]);
  });

  it("is not settled by a later step that merely mentions its site", async () => {
    const w = world();
    await w.requests.request(BOT, "work", ask);
    const rows = w.rows();
    rows.push({ id: "step", at: 2_000_000, role: "bot", kind: "activity", tool: { name: "agent_browser_open", ok: true, input: "https://github.com/" } } as Message);
    w.settle.verified("dachs", "work", 0);
    expect(signInOutcome(w.rows()[0]!.signIn!)).toBeNull();
  });
});
