import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComputerAsks, type DesktopState, type OnlineComputer } from "./computer-asks.ts";
import type { LentPlatform } from "./lent-computers.ts";
import type { Message } from "./store.ts";

const bot = { id: "scout", name: "Scout", color: "blue" } as unknown as Parameters<ComputerAsks["ask"]>[0]["bot"];
const PC = { name: "HOME-PC", platform: "win32" } as const;
const desktop = (fields: Partial<DesktopState> = {}): DesktopState => ({ ...PC, paused: false, screen: { ready: true, reason: null }, terminal: false, ...fields });
const lends = (fields: Partial<OnlineComputer> = {}): OnlineComputer => ({ id: "pc-1", ...PC, computer: true, terminal: false, ...fields });

function fixture({ known = [{ platform: "win32" }] }: { known?: Array<{ platform: LentPlatform | null }> } = {}) {
  const threads = new Map<string, Message[]>();
  const list = (threadId: string) => threads.get(threadId) ?? (threads.set(threadId, []), threads.get(threadId)!);
  let next = 0;
  let activity = "working";
  const store = {
    appendMessage: (threadId: string, message: Partial<Message>) => { const added = { id: `m${++next}`, at: Date.now(), ...message } as Message; list(threadId).push(added); return added; },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => { const found = list(threadId).find((message) => message.id === id); if (found) Object.assign(found, patch); return found ?? null; },
    messagesFor: (threadId: string) => list(threadId),
    projectBotForTask: () => ({ id: "scout", name: "Scout", busy: true, activity }),
    setTaskActivity: (_id: string, _threadId: string, value: string) => { activity = value; },
    groupByThread: () => null,
  };
  const state = { online: [] as OnlineComputer[], known, carried: [] as Array<{ threadId: string; requestMessageId: string; text: string }>, busy: false, notified: 0 };
  const asks = new ComputerAsks({
    store: store as never,
    notify: () => { state.notified++; },
    online: () => state.online,
    known: () => state.known,
    carryOn: (ask, text) => { if (state.busy) return false; state.carried.push({ threadId: ask.threadId, requestMessageId: ask.requestMessageId, text }); return true; },
  });
  const cards = (threadId = "t1") => list(threadId).filter((message) => message.card?.computerAsk);
  const card = (threadId = "t1") => cards(threadId).at(-1)!.card!;
  const present = (state: DesktopState, answers: Parameters<ComputerAsks["present"]>[1] = [], heard = -1) =>
    asks.present(state, answers, { kind: "session", name: "Owner", person: "p_owner" }, heard, undefined, 10);
  return { asks, state, store, cards, card, present, activity: () => activity };
}

describe("a bot on the person's own Cloud asks to turn on what it needs from their computer", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 30, 12)); });
  afterEach(() => { vi.useRealTimers(); });

  it("says it is ready at once, with no card, when the computer lends what is needed", async () => {
    const f = fixture();
    f.state.online = [lends()];
    await expect(f.asks.ask({ threadId: "t1", bot, need: "screen", why: "Open Excel" })).resolves.toEqual({ state: "ready", computerId: "pc-1", device: "PC" });
    expect(f.cards()).toHaveLength(0);
  });

  it("paused: one card with Turn on; the app there hears it; Turn on on the card turns it on and the waiting call carries on", async () => {
    const f = fixture();
    await f.present(desktop({ paused: true }));
    const call = f.asks.ask({ threadId: "t1", bot, need: "screen", why: "Fill in the invoice in Excel", requestMessageId: "u1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cards()).toHaveLength(1);
    expect(f.card()).toMatchObject({
      title: "Scout wants to use your PC's apps and screen",
      subtitle: "Fill in the invoice in Excel\nUsing your PC is paused.",
      options: ["Turn on", "Not now"], requestType: "permission", tool: "turn_on_your_computer",
      computerAsk: { need: "screen", reason: "paused", device: "PC", state: "asking", why: "Fill in the invoice in Excel" },
    });
    expect(f.state.notified).toBe(1);
    expect(f.activity()).toBe("waiting-on-you");
    const heard = await f.present(desktop({ paused: true }));
    expect(heard.asks).toEqual([expect.objectContaining({ need: "screen", reason: "paused", bot: "Scout", why: "Fill in the invoice in Excel", state: "asking", turnOn: 0 })]);

    expect(f.asks.answer(f.card().requestId!, "allow")).toBe(true);
    expect(f.card()).toMatchObject({ answered: "allow", computerAsk: { state: "turning-on" } });
    expect((await f.present(desktop({ paused: true }), [], heard.version)).asks[0]).toMatchObject({ state: "turning-on", turnOn: 1 });

    f.state.online = [lends()];
    await f.present(desktop());
    await expect(call).resolves.toEqual({ state: "ready", computerId: "pc-1", device: "PC" });
    expect(f.card()).toMatchObject({ answered: "allow", computerAsk: { state: "on" } });
    expect(f.card().dismissed).toBeUndefined();
    expect(f.activity()).toBe("working");
    expect(f.state.carried, "the waiting call carried on, so nothing else is started").toEqual([]);
  });

  it("not answered within the call: the bot is told to end its turn, and its request goes on by itself once it's on", async () => {
    const f = fixture();
    await f.present(desktop({ screen: { ready: false, reason: "not-running" } }));
    f.state.online = [lends({ computer: false })];
    const call = f.asks.ask({ threadId: "t1", bot, need: "screen", why: "Open Excel", requestMessageId: "u1" }, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const reply = await call;
    expect(reply).toEqual({ state: "waiting", device: "PC", reason: "not-running" });
    const said = ComputerAsks.say(reply, "Scout");
    expect(said).toContain("End your turn now");
    expect(said).toContain("Screen control isn't running on your PC.");
    expect(said).toContain("Don't switch to your own cloud computer");

    f.state.busy = true;
    f.asks.answer(f.card().requestId!, "allow");
    f.state.online = [lends()];
    await f.present(desktop());
    expect(f.card().computerAsk?.state).toBe("on");
    expect(f.state.carried, "the conversation is busy: it waits").toEqual([]);
    f.state.busy = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.state.carried).toEqual([{ threadId: "t1", requestMessageId: "u1", text: expect.stringContaining("Carry on with their request where you left off") }]);
  });

  it("Not now: the bot is told, and the same bot asking again in that conversation isn't put to them again for a while", async () => {
    const f = fixture();
    await f.present(desktop({ paused: true }));
    const call = f.asks.ask({ threadId: "t1", bot, need: "folders", why: "Read the budget" });
    await vi.advanceTimersByTimeAsync(0);
    f.asks.answer(f.card().requestId!, "deny");
    await expect(call).resolves.toEqual({ state: "declined", device: "PC", reason: "paused" });
    expect(f.card()).toMatchObject({ answered: "deny", computerAsk: { state: "declined" } });
    await expect(f.asks.ask({ threadId: "t1", bot, need: "folders" }, 10)).resolves.toMatchObject({ state: "declined" });
    expect(f.cards()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await f.present(desktop({ paused: true }));
    void f.asks.ask({ threadId: "t1", bot, need: "folders" }, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cards(), "asked again once a while has passed").toHaveLength(2);
  });

  it("the app closed: no Turn on, the fix is opening it; the card follows the app when it comes back", async () => {
    const f = fixture();
    const call = f.asks.ask({ threadId: "t1", bot, need: "screen", why: "Open Excel" }, 30_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.card()).toMatchObject({ options: ["Not now"], computerAsk: { reason: "closed", device: "PC" } });
    expect(f.card().subtitle).toContain("MausBot isn't open on your PC. Open it there and Scout carries on.");
    await f.present(desktop({ paused: true }));
    expect(f.card()).toMatchObject({ options: ["Turn on", "Not now"], computerAsk: { reason: "paused" } });
    f.state.online = [lends()];
    await f.present(desktop());
    await expect(call).resolves.toMatchObject({ state: "ready" });
    expect(f.card(), "nobody tapped: the harness settled it, in nobody's words").toMatchObject({ answered: "allow", dismissed: true, computerAsk: { state: "on" } });
  });

  it("never lent: the card says to install the app; an app too old to answer says to update it", async () => {
    const never = fixture({ known: [] });
    void never.asks.ask({ threadId: "t1", bot, need: "screen" }, 30_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(never.card().computerAsk).toMatchObject({ reason: "never", device: "computer" });
    const old = fixture();
    old.state.online = [lends({ computer: false })];
    void old.asks.ask({ threadId: "t1", bot, need: "screen" }, 30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.card().computerAsk).toMatchObject({ reason: "update", device: "PC" });
  });

  it("the app's own prompt: its Turn on and Not now are the person's, and a start that fails says why and offers Try again", async () => {
    const f = fixture();
    await f.present(desktop({ screen: { ready: false, reason: "not-running" } }));
    f.state.online = [lends({ computer: false })];
    void f.asks.ask({ threadId: "t1", bot, need: "screen" }, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    const id = f.card().requestId!;
    await f.present(desktop({ screen: { ready: false, reason: "not-running" } }), [{ id, outcome: "turning-on" }]);
    expect(f.card()).toMatchObject({ answered: "allow", answeredBy: { kind: "session", name: "Owner", person: "p_owner" }, computerAsk: { state: "turning-on" } });
    await f.present(desktop({ screen: { ready: false, reason: "blocked" } }), [{ id, outcome: "failed", reason: "blocked" }]);
    expect(f.card()).toMatchObject({ options: ["Try again", "Not now"], computerAsk: { state: "failed", reason: "blocked" } });
    expect(f.card().answered, "back in front of the person").toBeUndefined();
    expect(f.card().subtitle).toContain("Windows Security may have stopped it");
    await expect(f.asks.ask({ threadId: "t1", bot, need: "screen" })).resolves.toEqual({ state: "failed", device: "PC", reason: "blocked" });
    await f.present(desktop({ screen: { ready: false, reason: "blocked" } }), [{ id, outcome: "declined" }]);
    expect(f.card()).toMatchObject({ answered: "deny", answeredBy: { kind: "session", name: "Owner", person: "p_owner" }, computerAsk: { state: "declined" } });
  });

  it("a Turn on that never takes says so after a while", async () => {
    const f = fixture();
    await f.present(desktop({ paused: true }));
    void f.asks.ask({ threadId: "t1", bot, need: "screen" }, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    f.asks.answer(f.card().requestId!, "allow");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.card().computerAsk).toMatchObject({ state: "failed", reason: "closed" });
  });

  it("a Mac lacking macOS's permissions lends its screen but isn't ready: the card asks to allow it", async () => {
    const f = fixture({ known: [{ platform: "darwin" }] });
    await f.present(desktop({ name: "Mac", platform: "darwin", screen: { ready: false, reason: "permissions" } }));
    f.state.online = [lends({ name: "Mac", platform: "darwin" })];
    void f.asks.ask({ threadId: "t1", bot, need: "screen" }, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.card()).toMatchObject({ options: ["Turn on", "Not now"], computerAsk: { reason: "permissions", device: "Mac" } });
    await f.present(desktop({ name: "Mac", platform: "darwin" }));
    expect(f.card().computerAsk?.state).toBe("on");
  });

  it("one card per need in a conversation; Stop ends it", async () => {
    const f = fixture();
    await f.present(desktop({ paused: true }));
    const first = f.asks.ask({ threadId: "t1", bot, need: "screen" }, 60_000);
    const second = f.asks.ask({ threadId: "t1", bot, need: "screen" }, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cards()).toHaveLength(1);
    f.asks.cancel("t1");
    await expect(first).resolves.toMatchObject({ state: "declined" });
    await expect(second).resolves.toMatchObject({ state: "declined" });
    expect(f.card()).toMatchObject({ dismissed: true, computerAsk: { state: "ended" } });
  });

  it("starting by itself: no card, the bot is told to call again in a moment", async () => {
    const f = fixture();
    await f.present(desktop({ screen: { ready: false, reason: "starting" } }));
    const call = f.asks.ask({ threadId: "t1", bot, need: "screen" }, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toEqual({ state: "waiting", device: "PC", reason: "starting" });
    expect(f.cards()).toHaveLength(0);
  });

  it("the words the bot gets never send it to its own cloud computer, and name the computer it can use", () => {
    expect(ComputerAsks.say({ state: "ready", computerId: "pc-1", device: "PC" }, "Scout")).toContain("computer_id pc-1");
    for (const state of ["declined", "failed", "unavailable"] as const) {
      expect(ComputerAsks.say({ state, device: "PC", reason: "unsupported" }, "Scout")).toContain("Don't switch to your own cloud computer");
    }
  });
});
