import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingSession } from "./meeting-session.ts";
import { resolveMeetingPrice, meetingUsageCost } from "./meeting-pricing.ts";
import { normalizeMeetingLimits } from "../shared/meeting-limits.ts";

const price = resolveMeetingPrice("model", [{ id: "provider/model", pricing: { prompt: "0.000002", completion: "0.000004", input_cache_read: "0.0000002" } }], 0);
afterEach(() => vi.useRealTimers());
describe("meeting accounting and enforcement", () => {
  it("counts cumulative usage once across updates, completion and private checks", () => {
    const stop = vi.fn(), persist = vi.fn();
    const meeting = new MeetingSession(normalizeMeetingLimits({ tokens: { hardStop: 500 } }), { replies: () => 0, persist, stop, notice: vi.fn() });
    meeting.beginTurn("public");
    meeting.usage("public", { input: 100, cachedInput: 80, output: 20 });
    meeting.usage("public", { input: 100, cachedInput: 80, output: 30 });
    meeting.usage("public", { input: 100, cachedInput: 80, output: 30 });
    meeting.endTurn("public");
    meeting.usage("public", { input: 999 }); // late event is no longer owned
    meeting.beginTurn("private");
    meeting.usage("private", { input: 200, output: 50 });
    meeting.endTurn("private");
    expect(meeting.state.tokens).toBe(380);
    expect(stop).not.toHaveBeenCalled();
    meeting.beginTurn("last"); meeting.usage("last", { input: 120 });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(meeting.check()).toBe(false);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ tokens: 500 }));
    meeting.close();
  });
  it("interrupts at wall time even while a provider is waiting, and closes timers", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const stop = vi.fn(), notice = vi.fn();
    const meeting = new MeetingSession(normalizeMeetingLimits({ time: { seconds: 10, wrapUpSeconds: 7 } }), { replies: () => 0, persist: vi.fn(), stop, notice });
    meeting.start(); vi.advanceTimersByTime(7000);
    expect(stop).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Do not stop immediately"), false, 0);
    vi.advanceTimersByTime(3000); expect(stop).toHaveBeenCalledTimes(1);
    meeting.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("resumes a saved allowance instead of granting more tokens to bot continuations", () => {
    const meeting = new MeetingSession(normalizeMeetingLimits({ tokens: { hardStop: 100 } }), {
      replies: () => 2, persist: vi.fn(), stop: vi.fn(), notice: vi.fn(), now: () => 3000,
    }, { startedAt: 1000, tokens: 90 });
    expect(meeting.snapshot().tokens?.remaining).toBe(10);
    expect(meeting.state.startedAt).toBe(1000);
    meeting.close();
  });
  it("applies the earliest cap and prices cached input once", () => {
    const stop = vi.fn();
    const meeting = new MeetingSession(normalizeMeetingLimits({ replies: { hardStop: 10 }, cost: { hardStopUsd: 0.0003 } }), { replies: () => 1, persist: vi.fn(), notice: vi.fn(), stop });
    meeting.beginTurn("one"); meeting.usage("one", { input: 100, cachedInput: 80, output: 20 }, price);
    expect(meeting.state.costUsd).toBeCloseTo(0.000136);
    meeting.endTurn("one");
    meeting.beginTurn("two"); meeting.usage("two", { input: 100 }, price);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(meeting.snapshot().reasons).toEqual(["dollar"]);
    meeting.close();
  });
  it("rejects missing, ambiguous, tiered and unaccountable fixed pricing", () => {
    expect(() => resolveMeetingPrice("missing", [], 0)).toThrow();
    expect(() => resolveMeetingPrice("m", [{ id: "a/m" }, { id: "b/m" }], 0)).toThrow(/unique/);
    for (const pricing of [{ prompt: -1, completion: 0 }, { prompt: 1, completion: 1, request: 1 }, { prompt: 1, completion: 1, overrides: [{}] }]) {
      expect(() => resolveMeetingPrice("m", [{ id: "a/m", pricing }], 0)).toThrow();
    }
    expect(meetingUsageCost({ input: 100, cachedInput: 200 }, price)).toBeCloseTo(0.00002);
  });
  it("stops usage-limited meetings when a completed provider turn omits accounting", () => {
    const stop = vi.fn();
    const meeting = new MeetingSession(normalizeMeetingLimits({ tokens: { hardStop: 100 } }), { replies: () => 0, persist: vi.fn(), notice: vi.fn(), stop });
    meeting.beginTurn("cancelled"); meeting.endTurn("cancelled", false);
    expect(stop).not.toHaveBeenCalled();
    meeting.beginTurn("missing"); meeting.endTurn("missing");
    expect(stop).toHaveBeenCalledWith(expect.stringContaining("did not report complete token usage"));
    expect(meeting.check()).toBe(false);
    meeting.close();
  });
});
