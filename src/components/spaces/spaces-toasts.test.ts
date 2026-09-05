import { describe, expect, it } from "vitest";

import { MAX_TOASTS, TOAST_TTL_MS, expireToasts, lastSettled, mergeToasts, settledSince } from "./spaces-toasts";

const msg = (over: Record<string, unknown>) => ({ id: "m", role: "bot", kind: "text", ...over }) as never;

describe("lastSettled", () => {
  it("finds the last settled assistant message", () => {
    const found = lastSettled([
      msg({ id: "a", turnTerminal: true, text: "first" }),
      msg({ id: "b", turnTerminal: true, text: "second" }),
    ]);
    expect(found?.id).toBe("b");
    expect(found?.text).toBe("second");
  });

  it("ignores messages still streaming and anything the user sent", () => {
    expect(lastSettled([msg({ id: "a", text: "mid-turn" })])).toBeNull();
    expect(lastSettled([msg({ id: "a", role: "user", turnTerminal: true })])).toBeNull();
  });

  it("has nothing to report for an empty thread", () => {
    expect(lastSettled([])).toBeNull();
  });
});

describe("settledSince", () => {
  const subject = (id: string, settledId: string | null) => ({
    id,
    name: id.toUpperCase(),
    settled: settledId ? { id: settledId, text: `${id} finished` } : null,
  });

  it("reports a bot that settled something new", () => {
    const events = settledSince({ a: "m1" }, [subject("a", "m2")], null, 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subjectId: "a", name: "A", text: "a finished", at: 1000 });
  });

  it("says nothing when the message has not changed", () => {
    expect(settledSince({ a: "m2" }, [subject("a", "m2")], null, 1000)).toHaveLength(0);
  });

  it("never toasts the card you are already looking at", () => {
    expect(settledSince({ a: "m1" }, [subject("a", "m2")], "a", 1000)).toHaveLength(0);
  });

  it("stays quiet on the first sighting of a bot, rather than announcing history", () => {
    expect(settledSince({}, [subject("a", "m1")], null, 1000)).toHaveLength(0);
  });

  it("reports each bot that settled, not just the first", () => {
    const events = settledSince({ a: "m1", b: "m1" }, [subject("a", "m2"), subject("b", "m9")], null, 5);
    expect(events.map((e) => e.subjectId)).toEqual(["a", "b"]);
  });
});

describe("mergeToasts", () => {
  const toast = (subjectId: string, at: number) => ({ id: `${subjectId}-${at}`, subjectId, name: subjectId, text: "x", at });

  it("replaces a bot's toast rather than stacking a second one", () => {
    const merged = mergeToasts([toast("a", 1)], [toast("a", 2)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].at).toBe(2);
  });

  it("keeps only the newest few", () => {
    const merged = mergeToasts([], [toast("a", 1), toast("b", 2), toast("c", 3), toast("d", 4)]);
    expect(merged).toHaveLength(MAX_TOASTS);
    expect(merged.map((t) => t.subjectId)).toEqual(["b", "c", "d"]);
  });

  it("orders oldest first so the stack grows downward", () => {
    const merged = mergeToasts([toast("a", 5)], [toast("b", 1)]);
    expect(merged.map((t) => t.at)).toEqual([1, 5]);
  });
});

describe("expireToasts", () => {
  const toast = (at: number) => ({ id: `t${at}`, subjectId: `s${at}`, name: "n", text: "x", at });

  it("drops toasts past their lifetime and keeps the rest", () => {
    const now = 10_000;
    const kept = expireToasts([toast(now - TOAST_TTL_MS - 1), toast(now - 100)], now);
    expect(kept).toHaveLength(1);
    expect(kept[0].at).toBe(now - 100);
  });

  it("returns the same array when nothing expired, so React can bail out", () => {
    const toasts = [toast(9_900)];
    expect(expireToasts(toasts, 10_000)).toBe(toasts);
  });
});
