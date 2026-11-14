import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnResources, type TurnOwner } from "../turn-resources.ts";
import { BROWSER_HANDED_OVER, BROWSER_WAITED, browserBusyText, browserResource, createBrowserSeats } from "./browser-seats.ts";

const A: TurnOwner = { threadId: "a", generation: "g-a" }, B: TurnOwner = { threadId: "b", generation: "g-b" }, C: TurnOwner = { threadId: "c", generation: "g-c" };
const SESSION = "bot-1", RESOURCE = browserResource(SESSION);

function seats(options: { working?: boolean; idleHandoverMs?: number; callWaitMs?: number } = {}) {
  const resources = new TurnResources(), rows: Array<{ threadId: string; name: string }> = [], events: string[] = [];
  const ended = new Set<string>();
  const state = { working: options.working ?? false, clock: 1_000 };
  const seat = createBrowserSeats({
    resources, claim: (owner, resource) => resources.claim(resource, owner), active: (owner) => !ended.has(owner.generation), working: () => state.working,
    holderOf: (owner) => ({ holder: { name: "Scout", task: `job ${owner.threadId}` } }), language: () => undefined,
    row: (threadId, name) => { rows.push({ threadId, name }); },
    waitStarted: (threadId, resource, position) => { events.push(`started ${threadId} ${resource} ${position}`); },
    waitEnded: (threadId, _resource, outcome) => { events.push(`${outcome} ${threadId}`); },
    callWaitMs: options.callWaitMs ?? 20, actWithinMs: 1_000_000, idleHandoverMs: options.idleHandoverMs ?? 1_000_000, pollMs: 2, now: () => state.clock,
  });
  const end = (owner: TurnOwner) => { ended.add(owner.generation); resources.release(owner); };
  return { seat, resources, rows, events, state, end };
}
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 2 });

describe("one bot's browser between its conversations", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("lets the same turn keep calling, and answers another turn's call with why, naming the wait in its chat", async () => {
    const { seat, resources, rows, events, end } = seats();
    expect(await seat.take(A, SESSION)).toBeNull();
    expect(await seat.take(A, SESSION)).toBeNull();
    expect(await seat.take(B, SESSION)).toBe(browserBusyText(20));
    expect(rows).toEqual([{ threadId: "b", name: "Waiting for the browser: Scout is using it for job a. This continues by itself when it is free." }]);
    expect(events).toEqual([`started b ${RESOURCE} 1`]);
    expect(await seat.take(B, SESSION), "a second call joins the wait already under way").toBe(browserBusyText(20));
    expect(rows).toHaveLength(1);
    end(A);
    await until(() => resources.owns(RESOURCE, B));
    expect(rows.at(-1)).toEqual({ threadId: "b", name: "The browser is free. Continuing." });
    expect(await seat.take(B, SESSION)).toBeNull();
    end(B);
  });

  it("serves waiters in the order they came", async () => {
    const { seat, resources, end } = seats();
    await seat.take(A, SESSION);
    await seat.take(B, SESSION);
    await seat.take(C, SESSION);
    end(A);
    await until(() => resources.owns(RESOURCE, B));
    expect(resources.owns(RESOURCE, C)).toBe(false);
    end(B);
    await until(() => resources.owns(RESOURCE, C));
    end(C);
  });

  it("stops a wait when its turn ends, and says so", async () => {
    const { seat, rows, events, end } = seats();
    await seat.take(A, SESSION);
    await seat.take(B, SESSION);
    end(B);
    await until(() => events.includes("stopped b"));
    expect(rows.at(-1)).toEqual({ threadId: "b", name: "Stopped waiting for the browser." });
    end(A);
  });

  it("does not perform a call that waited longer than the engine may still be waiting for it", async () => {
    const resources = new TurnResources();
    let clock = 0;
    const seat = createBrowserSeats({
      resources, claim: (owner, resource) => resources.claim(resource, owner), active: () => true, working: () => false, holderOf: () => ({}), language: () => undefined, row: () => {},
      waitStarted: () => {}, waitEnded: () => {}, callWaitMs: 200, actWithinMs: 5_000, idleHandoverMs: 1_000_000, pollMs: 1, now: () => clock,
    });
    await seat.take(A, SESSION);
    const late = seat.take(B, SESSION);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock += 6_000;
    resources.release(A);
    expect(await late).toBe(BROWSER_WAITED);
    expect(await seat.take(B, SESSION)).toBeNull();
  });

  it("hands a browser its holder has stopped using to the conversation waiting, and refuses the holder's next call once", async () => {
    const { seat, resources, state, end } = seats({ idleHandoverMs: 60_000 });
    await seat.take(A, SESSION);
    await seat.take(B, SESSION);
    expect(resources.owns(RESOURCE, A)).toBe(true);
    state.clock += 59_000;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resources.owns(RESOURCE, A), "a pause for thought keeps it").toBe(true);
    state.clock += 2_000;
    await until(() => resources.owns(RESOURCE, B));
    expect(await seat.take(B, SESSION)).toBeNull();
    end(B);
    expect(await seat.take(A, SESSION), "nothing lands on a page this turn did not open").toBe(BROWSER_HANDED_OVER);
    expect(await seat.take(A, SESSION)).toBeNull();
    end(A);
  });

  it("never takes it from a holder with a call running or a person's hands in the browser", async () => {
    const { seat, resources, state, end } = seats({ idleHandoverMs: 60_000, working: true });
    await seat.take(A, SESSION);
    await seat.take(B, SESSION);
    state.clock += 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resources.owns(RESOURCE, A)).toBe(true);
    state.working = false;
    await until(() => resources.owns(RESOURCE, B));
    end(A); end(B);
  });

  it("gives a holder that is still using it the whole allowance again after each call", async () => {
    const { seat, resources, state, end } = seats({ idleHandoverMs: 60_000 });
    await seat.take(A, SESSION);
    await seat.take(B, SESSION);
    state.clock += 59_000;
    seat.used(A, SESSION);
    state.clock += 59_000;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resources.owns(RESOURCE, A)).toBe(true);
    end(A); end(B);
  });
});
