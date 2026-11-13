import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPhoneHold } from "../phone-screen/hold.ts";
import { TurnResources, type TurnOwner } from "../turn-resources.ts";
import { createPhoneGate } from "./phone-gate.ts";
import { PASS } from "./table.ts";

const PHONE = "computer:phone";
const SECOND = 1000;
const CLAIMED = { status: 200, body: { claimed: true } };
const BUSY = { status: 409, body: { error: "another thread is using the phone" } };
const PERSON = { status: 423, body: { reason: "person" } };
const HANDED_BACK = { status: 423, body: { reason: "handed-back" } };
const TURN_ENDED = Object.assign(new Error("turn ended"), { status: 401 });
const MID_CALL = { wait: false };

const turn = (threadId: string, generation = "1"): TurnOwner => ({ threadId, generation });

function phone(enabled = true) {
  const resources = new TurnResources();
  const hold = createPhoneHold({ onChange: (held) => gate.holdChanged(held) });
  const gate = createPhoneGate({ enabled: () => enabled, hold, resources, claim: (owner, resource) => resources.claim(resource, owner) });
  const request = async (owner: TurnOwner, options: { method?: string; path?: string; signal?: AbortSignal; active?: () => boolean; body?: unknown } = {}) => {
    const json = vi.fn();
    const outcome = await gate.internal({
      method: options.method ?? "POST", path: options.path ?? "/api/internal/phone/claim", res: {} as never, json, turn: owner,
      signal: options.signal ?? new AbortController().signal,
      requireActive: () => { if (options.active && !options.active()) throw TURN_ENDED; },
      readBody: async () => options.body ?? {},
    });
    if (outcome === PASS) return PASS;
    const [, status, body] = json.mock.calls[0] ?? [];
    return { status, body };
  };
  return { resources, hold, claim: request };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the phone claim while no person holds the phone", () => {
  it("claims the phone for the turn", async () => {
    const { resources, claim } = phone();
    const a = turn("a");
    expect(await claim(a)).toEqual(CLAIMED);
    expect(resources.holder(PHONE)).toBe(a);
  });

  it("refuses while another thread's turn has the phone", async () => {
    const { resources, claim } = phone();
    const b = turn("b");
    expect(await claim(b)).toEqual(CLAIMED);
    expect(await claim(turn("a"))).toEqual(BUSY);
    expect(resources.holder(PHONE)).toBe(b);
  });

  it("refuses a turn that has ended", async () => {
    const { resources, claim } = phone();
    await expect(claim(turn("a"), { active: () => false })).rejects.toBe(TURN_ENDED);
    expect(resources.free(PHONE)).toBe(true);
  });

  it("asks again whether the turn is still on after the wait", async () => {
    const { resources, claim } = phone();
    const answers = [true, false];
    await expect(claim(turn("a"), { active: () => answers.shift() ?? false })).rejects.toBe(TURN_ENDED);
    expect(resources.free(PHONE)).toBe(true);
  });

  it.each([["GET", "/api/internal/phone/claim"], ["POST", "/api/internal/phone/mcp"]])("passes %s %s on", async (method, path) => {
    const { claim } = phone();
    expect(await claim(turn("a"), { method, path })).toBe(PASS);
  });
});

describe("the phone claim while a person holds the phone", () => {
  it("answers person after 45 seconds and claims nothing", async () => {
    const { resources, hold, claim } = phone();
    hold.take();
    const answered = vi.fn();
    const answer = claim(turn("a")).then((result) => { answered(); return result; });
    await vi.advanceTimersByTimeAsync(45 * SECOND - 1);
    expect(answered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual(PERSON);
    expect(resources.free(PHONE)).toBe(true);
  });

  it.each([[{ wait: true }], [{ wait: "false" }], [null]])("makes a claim with the body %j wait as one with no body does", async (body) => {
    const { hold, claim } = phone();
    hold.take();
    const answered = vi.fn();
    const answer = claim(turn("a"), { body }).then((result) => { answered(); return result; });
    await vi.advanceTimersByTimeAsync(45 * SECOND - 1);
    expect(answered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual(PERSON);
  });

  it("answers person at once to a claim from the middle of a call, and claims nothing", async () => {
    const { resources, hold, claim } = phone();
    hold.take();
    const waits = vi.getTimerCount();
    expect(await claim(turn("a"), { body: MID_CALL })).toEqual(PERSON);
    expect(vi.getTimerCount()).toBe(waits);
    expect(resources.free(PHONE)).toBe(true);
  });

  it("answers a claim from the middle of a call as any other once the person has handed back", async () => {
    const { hold, claim } = phone();
    const a = turn("a");
    expect(await claim(a)).toEqual(CLAIMED);
    hold.take();
    hold.release();
    expect(await claim(a, { body: MID_CALL })).toEqual(HANDED_BACK);
    expect(await claim(a, { body: MID_CALL })).toEqual(CLAIMED);
    expect(await claim(turn("b"), { body: MID_CALL })).toEqual(BUSY);
  });

  it("answers handed-back to a waiting call as soon as the person hands back, then lets the turn claim", async () => {
    const { resources, hold, claim } = phone();
    const a = turn("a");
    hold.take();
    const answer = claim(a);
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    hold.release();
    expect(await answer).toEqual(HANDED_BACK);
    expect(resources.free(PHONE)).toBe(true);
    expect(await claim(a)).toEqual(CLAIMED);
  });

  it("refuses a waiting turn that already had the phone once, not twice", async () => {
    const { hold, claim } = phone();
    const a = turn("a");
    expect(await claim(a)).toEqual(CLAIMED);
    hold.take();
    const answer = claim(a);
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    hold.release();
    expect(await answer).toEqual(HANDED_BACK);
    expect(await claim(a)).toEqual(CLAIMED);
  });

  it("refuses the next call of the turn that had the phone and was not waiting, once", async () => {
    const { hold, claim } = phone();
    const a = turn("a");
    expect(await claim(a)).toEqual(CLAIMED);
    hold.take();
    hold.release();
    expect(await claim(a)).toEqual(HANDED_BACK);
    expect(await claim(a)).toEqual(CLAIMED);
  });

  it("claims nothing for a waiting call whose turn was stopped, so another thread gets the phone", async () => {
    const { resources, hold, claim } = phone();
    hold.take();
    const stopped = new AbortController();
    const answer = claim(turn("a"), { signal: stopped.signal });
    stopped.abort();
    expect(await answer).toEqual(PERSON);
    hold.release();
    expect(resources.free(PHONE)).toBe(true);
    expect(await claim(turn("b"))).toEqual(CLAIMED);
  });

  it("answers handed-back to a waiting thread that does not have the phone, and busy until the turn that has it ends", async () => {
    const { resources, hold, claim } = phone();
    const a = turn("a");
    const b = turn("b");
    expect(await claim(a)).toEqual(CLAIMED);
    hold.take();
    const answer = claim(b);
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    hold.release();
    expect(await answer).toEqual(HANDED_BACK);
    expect(await claim(b)).toEqual(BUSY);
    expect(await claim(a)).toEqual(HANDED_BACK);
    expect(await claim(a)).toEqual(CLAIMED);
    expect(await claim(b)).toEqual(BUSY);
    resources.release(a);
    expect(await claim(b)).toEqual(CLAIMED);
  });

  it.each([
    ["the same thread's next turn", turn("a", "2")],
    ["another thread's turn", turn("b")],
  ])("never refuses %s for a hand-back to a turn that has ended", async (_, next) => {
    const { resources, hold, claim } = phone();
    const a = turn("a");
    expect(await claim(a)).toEqual(CLAIMED);
    hold.take();
    hold.release();
    resources.release(a);
    expect(await claim(next)).toEqual(CLAIMED);
  });

  it("refuses only the turn that has the phone at the latest hand-back", async () => {
    const { resources, hold, claim } = phone();
    const a = turn("a");
    const b = turn("b");
    expect(await claim(a)).toEqual(CLAIMED);
    hold.take();
    hold.release();
    resources.release(a);
    expect(await claim(b)).toEqual(CLAIMED);
    hold.take();
    hold.release();
    expect(await claim(b)).toEqual(HANDED_BACK);
    expect(await claim(b)).toEqual(CLAIMED);
  });
});

describe("the phone claim with the feature off", () => {
  it("claims and refuses a busy phone as before", async () => {
    const { resources, claim } = phone(false);
    const a = turn("a");
    expect(await claim(a)).toEqual(CLAIMED);
    expect(await claim(a)).toEqual(CLAIMED);
    expect(await claim(turn("b"))).toEqual(BUSY);
    expect(resources.holder(PHONE)).toBe(a);
    await expect(claim(a, { active: () => false })).rejects.toBe(TURN_ENDED);
  });

  it("neither waits for a hold nor refuses for a hand-back", async () => {
    const { hold, claim } = phone(false);
    const a = turn("a");
    hold.take();
    expect(await claim(a)).toEqual(CLAIMED);
    expect(await claim(a, { body: MID_CALL })).toEqual(CLAIMED);
    hold.release();
    expect(await claim(a)).toEqual(CLAIMED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
