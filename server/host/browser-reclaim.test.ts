import { describe, expect, it } from "vitest";

import { createBrowserReclaim, RECLAIM_ASK_MS, reclaimable, type ReclaimCandidate } from "./browser-reclaim.ts";

const spare: ReclaimCandidate = { session: "bot-a", held: false, working: false, running: true, attached: false, watched: false, turnRunning: false, savesSignIns: true };

describe("reclaimable", () => {
  it("never a browser a turn holds, a call runs in, that isn't running, or that is the person's own Chrome", () => {
    for (const thrashing of [false, true]) {
      expect(reclaimable({ ...spare, held: true }, thrashing)).toBe(false);
      expect(reclaimable({ ...spare, working: true }, thrashing)).toBe(false);
      expect(reclaimable({ ...spare, running: false }, thrashing)).toBe(false);
      expect(reclaimable({ ...spare, attached: true }, thrashing)).toBe(false);
      expect(reclaimable(spare, thrashing)).toBe(true);
    }
  });

  it("a watched one, one of a running turn not used yet, or one losing its sign-ins only once the machine thrashes", () => {
    for (const keep of [{ watched: true }, { turnRunning: true }, { savesSignIns: false }]) {
      expect(reclaimable({ ...spare, ...keep }, false)).toBe(false);
      expect(reclaimable({ ...spare, ...keep }, true)).toBe(true);
    }
  });
});

describe("createBrowserReclaim", () => {
  it("asks each browser that may go once a minute, logs only a close that worked, and forgets old asks", async () => {
    let clock = 1_800_000_000_000;
    const closes: string[] = [], logs: string[] = [];
    const results = new Map([["bot-a", true], ["bot-b", false]]);
    const seenBusy: Array<readonly string[]> = [];
    let candidates: ReclaimCandidate[] = [spare, { ...spare, session: "bot-b" }, { ...spare, session: "bot-held", held: true }];
    const reclaim = createBrowserReclaim({
      candidates: (busy) => { seenBusy.push(busy); return candidates; },
      close: async (session) => { closes.push(session); return results.get(session) ?? false; },
      log: (line) => logs.push(line), now: () => clock,
    });
    expect(reclaim.reclaim({ thrashing: false, busy: ["t1"] })).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toEqual(["bot-a", "bot-b"]);
    expect(seenBusy).toEqual([["t1"]]);
    expect(logs).toEqual(["browser bot-a: closed to free memory, no task was using it"]);
    // The one whose close failed is not counted again within the minute.
    clock += RECLAIM_ASK_MS - 1;
    expect(reclaim.reclaim({ thrashing: false, busy: [] })).toBe(0);
    expect(reclaim.asked()).toEqual(["bot-a", "bot-b"]);
    // After it, old asks are forgotten: what still runs may be asked again.
    clock += 1;
    candidates = [{ ...spare, session: "bot-b" }];
    expect(reclaim.reclaim({ thrashing: false, busy: [] })).toBe(1);
    expect(reclaim.asked()).toEqual(["bot-b"]);
  });
});
