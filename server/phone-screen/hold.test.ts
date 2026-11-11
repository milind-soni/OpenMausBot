import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPhoneHold } from "./hold.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a person's hold on the phone", () => {
  it("starts when taken and ends when released", () => {
    const hold = createPhoneHold();
    expect(hold.held).toBe(false);
    hold.take();
    expect(hold.held).toBe(true);
    hold.release();
    expect(hold.held).toBe(false);
  });

  it("ends after 5 minutes without input", () => {
    const hold = createPhoneHold();
    hold.take();
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hold.held).toBe(false);
  });

  it.each(["used", "take"] as const)("counts the 5 minutes again from each input (%s)", (input) => {
    const hold = createPhoneHold();
    hold.take();
    vi.advanceTimersByTime(100 * SECOND);
    hold[input]();
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hold.held).toBe(false);
  });

  it("stays when every view closed for 1 minute 59 seconds and one came back", () => {
    const hold = createPhoneHold();
    hold.take();
    hold.watched(false);
    vi.advanceTimersByTime(119 * SECOND);
    hold.watched(true);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(hold.held).toBe(true);
  });

  it("ends when every view has been closed for 2 minutes", () => {
    const hold = createPhoneHold();
    hold.take();
    hold.watched(false);
    vi.advanceTimersByTime(2 * MINUTE - 1);
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hold.held).toBe(false);
  });

  it("ends at 300 s when the last input was at 0 s and the views closed from 290 s to 409 s", () => {
    const hold = createPhoneHold();
    hold.take();
    vi.advanceTimersByTime(290 * SECOND);
    hold.watched(false);
    vi.advanceTimersByTime(10 * SECOND - 1);
    expect(hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hold.held).toBe(false);
    vi.advanceTimersByTime(109 * SECOND);
    hold.watched(true);
    expect(hold.held).toBe(false);
  });

  it("gives a hold taken while no view is open the 2 minutes for one to open", () => {
    const hold = createPhoneHold();
    hold.watched(false);
    hold.take();
    vi.advanceTimersByTime(2 * MINUTE);
    expect(hold.held).toBe(false);
  });

  it("gives a hold taken 1 minute 50 seconds after the last view closed 2 minutes of its own", () => {
    const hold = createPhoneHold();
    hold.watched(false);
    vi.advanceTimersByTime(110 * SECOND);
    hold.take();
    vi.advanceTimersByTime(11 * SECOND);
    expect(hold.held).toBe(true);
  });

  it("does not start on input alone", () => {
    const changes: boolean[] = [];
    const hold = createPhoneHold({ onChange: (held) => changes.push(held) });
    hold.used();
    expect([hold.held, changes, vi.getTimerCount()]).toEqual([false, [], 0]);
  });

  it("uses the limits it is given", () => {
    const hold = createPhoneHold({ limits: { idleMs: 2 * SECOND, graceMs: SECOND } });
    hold.take();
    vi.advanceTimersByTime(2 * SECOND);
    expect(hold.held).toBe(false);
  });

  it("reports each start and each end once", () => {
    const changes: boolean[] = [];
    const hold = createPhoneHold({ onChange: (held) => changes.push(held) });
    hold.take();
    hold.take();
    hold.release();
    hold.release();
    expect(changes).toEqual([true, false]);
    hold.take();
    vi.advanceTimersByTime(5 * MINUTE);
    expect(changes).toEqual([true, false, true, false]);
  });

  it("leaves no timer running after stop", async () => {
    const hold = createPhoneHold();
    hold.take();
    hold.watched(false);
    const waiting = hold.wait(new AbortController().signal, 45 * SECOND);
    hold.stop();
    expect(vi.getTimerCount()).toBe(0);
    await expect(waiting).resolves.toBe("held");
  });
});

describe("waiting for the phone", () => {
  it("answers free at once when nobody holds it", async () => {
    const hold = createPhoneHold();
    await expect(hold.wait(new AbortController().signal, 45 * SECOND)).resolves.toBe("free");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers handed-back as soon as the hold ends", async () => {
    const hold = createPhoneHold();
    hold.take();
    const answered = vi.fn();
    const waiting = hold.wait(new AbortController().signal, 45 * SECOND).then((outcome) => { answered(); return outcome; });
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(answered).not.toHaveBeenCalled();
    hold.release();
    await expect(waiting).resolves.toBe("handed-back");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers held when the longest wait passes", async () => {
    const hold = createPhoneHold();
    hold.take();
    const answered = vi.fn();
    const waiting = hold.wait(new AbortController().signal, 45 * SECOND).then((outcome) => { answered(); return outcome; });
    await vi.advanceTimersByTimeAsync(45 * SECOND - 1);
    expect(answered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe("held");
    expect(hold.held).toBe(true);
  });

  it.each(["before", "during"] as const)("answers held when the caller is gone %s the wait", async (when) => {
    const hold = createPhoneHold();
    hold.take();
    const caller = new AbortController();
    if (when === "before") caller.abort();
    const waiting = hold.wait(caller.signal, 45 * SECOND);
    caller.abort();
    await expect(waiting).resolves.toBe("held");
    hold.release();
    expect(vi.getTimerCount()).toBe(0);
  });
});
