import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createTurnCallSignals } from "./turn-call-signals.ts";

const response = () => Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse & EventEmitter;

describe("turn call signals", () => {
  it("aborts the calls of a revoked grant on the next sweep and leaves the others running", () => {
    const active = new Set(["turn-1", "turn-2"]);
    const signals = createTurnCallSignals((grant: string) => active.has(grant));
    const first = signals.signal("turn-1", response()), second = signals.signal("turn-2", response());
    active.delete("turn-1");
    expect(first.aborted).toBe(false);
    signals.sweep();
    expect([first.aborted, second.aborted]).toEqual([true, false]);
  });

  it("aborts a call whose request closes before its answer, and not one that answered", () => {
    const signals = createTurnCallSignals(() => true);
    const dropped = response(), answered = response();
    const droppedSignal = signals.signal("turn", dropped), answeredSignal = signals.signal("turn", answered);
    dropped.emit("close");
    Object.assign(answered, { writableEnded: true }).emit("close");
    expect([droppedSignal.aborted, answeredSignal.aborted]).toEqual([true, false]);
  });

  it("forgets a call once its request closes, so a later sweep leaves it alone", () => {
    let live = true;
    const signals = createTurnCallSignals(() => live);
    const res = response();
    const signal = signals.signal("turn", res);
    Object.assign(res, { writableEnded: true }).emit("close");
    live = false;
    signals.sweep();
    expect(signal.aborted).toBe(false);
  });

  it.each([false, true])("handles a response closed before registration (writableEnded=%s)", (writableEnded) => {
    const signals = createTurnCallSignals(() => false);
    const res = Object.assign(response(), { closed: true, writableEnded });
    res.emit("close");
    const signal = signals.signal("turn", res);
    expect(signal.aborted).toBe(!writableEnded);
    signals.sweep();
    expect(signal.aborted).toBe(!writableEnded);
  });
});
