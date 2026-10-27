import { describe, expect, it } from "vitest";

import { PERSON_STOPPED_TURN_NAME, STOPPED_TURN_NAME } from "../shared/client-cancel.ts";
import { LiveTurns } from "./live-turns.ts";
import { PersonStops, stopReachesLiveTurn, stoppedTurnRow } from "./person-stops.ts";
import type { Message } from "./store.ts";

const row = (fields: Partial<Message>): Message => ({ id: `m-${Math.random()}`, at: 1, role: "bot", kind: "activity", ...fields }) as Message;

describe("PersonStops", () => {
  it("knows the turn the person stopped, and only that one", () => {
    const stops = new PersonStops();
    stops.stop("t1", "turn-1", false);
    expect(stops.stopped("t1", "turn-1")).toBe(true);
    expect(stops.stopped("t1", "turn-2")).toBe(false);
    expect(stops.stopped("t2", "turn-1")).toBe(false);
    stops.turnEnded("t1", "turn-1");
    expect(stops.stopped("t1", "turn-1")).toBe(false);
  });

  it("lets a Stop pressed during a dispatch cover any turn until a turn starts, and drops it at that start", () => {
    const stops = new PersonStops();
    stops.stop("t1", undefined, true);
    expect(stops.stopped("t1", "turn-1")).toBe(true);
    // The dispatched turn's own start drops the mark: a stopped dispatch's events never reach here, so a turn that
    // does start is one the Stop did not catch.
    stops.turnStarted("t1", "turn-9");
    expect(stops.stopped("t1", "turn-1")).toBe(false);
  });

  it("records nothing for a Stop that found nothing running", () => {
    const stops = new PersonStops();
    stops.stop("t1", undefined, false);
    expect(stops.stopped("t1", "turn-1")).toBe(false);
  });

  it("outlives another turn's end, but not the start of the next turn", () => {
    const stops = new PersonStops();
    stops.stop("t1", "turn-1", false);
    stops.turnEnded("t1", "turn-0");
    expect(stops.stopped("t1", "turn-1")).toBe(true);
    // turn-1's own end was lost: the next turn's start must not leave the mark behind.
    stops.turnStarted("t1", "turn-2");
    expect(stops.stopped("t1", "turn-1")).toBe(false);
  });
});

describe("LiveTurns", () => {
  const frame = (type: string, turnId: string, threadId = "t1") => ({ type, turnId, threadId }) as never;

  it("names the running turn from its start to its end", () => {
    const live = new LiveTurns(() => true);
    live.onEvent(frame("turn.started", "turn-1"));
    // Any other event naming a turn leaves it alone: only a start and an end move it.
    live.onEvent(frame("content.delta", "turn-0"));
    expect(live.running("t1")).toBe("turn-1");
    live.onEvent(frame("turn.completed", "turn-0"));
    expect(live.running("t1")).toBe("turn-1");
    live.onEvent(frame("turn.completed", "turn-1"));
    expect(live.running("t1")).toBeUndefined();
  });

  it("drops a turn whose end was lost once the next dispatch starts", () => {
    const live = new LiveTurns(() => true);
    live.onEvent(frame("turn.started", "turn-1"));
    live.dispatchStarted("t1");
    expect(live.running("t1")).toBeUndefined();
    live.onEvent(frame("turn.started", "turn-2"));
    expect(live.running("t1")).toBe("turn-2");
  });

  it("names nothing once the thread is idle, even when the end never arrived", () => {
    let busy = true;
    const live = new LiveTurns(() => busy);
    live.onEvent(frame("turn.started", "turn-1"));
    busy = false;
    expect(live.running("t1")).toBeUndefined();
  });
});

describe("stopReachesLiveTurn", () => {
  it("lets a Stop that names the live turn through", () => {
    expect(stopReachesLiveTurn("turn-1", "turn-1")).toBe(true);
  });

  it("stops nothing when the named turn is over, or the next one is running", () => {
    expect(stopReachesLiveTurn("turn-1", undefined)).toBe(false);
    expect(stopReachesLiveTurn("turn-1", "turn-2")).toBe(false);
  });

  it("keeps an older client's Stop, which names no turn, reaching whatever runs", () => {
    expect(stopReachesLiveTurn(undefined, "turn-2")).toBe(true);
  });
});

describe("stoppedTurnRow", () => {
  it("says the person stopped it when they did, and Stopped otherwise", () => {
    expect(stoppedTurnRow([], "turn-1", true)).toEqual({ role: "bot", kind: "activity", tool: { name: PERSON_STOPPED_TURN_NAME, ok: true }, turnId: "turn-1" });
    expect(stoppedTurnRow([], "turn-1", false)?.tool?.name).toBe(STOPPED_TURN_NAME);
    expect(PERSON_STOPPED_TURN_NAME).toBe("stopped: You stopped this.");
  });

  it("gives a turn one stopped row, even with rows after it", () => {
    const messages = [
      row({ role: "user", kind: "text", text: "go" }),
      row({ turnId: "turn-1", tool: { name: PERSON_STOPPED_TURN_NAME, ok: true } }),
      row({ turnId: "turn-1", tool: { name: "notice: OpenCode answered after a slow start.", ok: true } }),
    ];
    expect(stoppedTurnRow(messages, "turn-1", true)).toBeNull();
    expect(stoppedTurnRow(messages, "turn-2", true)).not.toBeNull();
  });

  it("never counts an earlier request's stop", () => {
    const messages = [
      row({ turnId: "turn-1", tool: { name: STOPPED_TURN_NAME, ok: true } }),
      row({ role: "user", kind: "text", text: "again" }),
    ];
    expect(stoppedTurnRow(messages, "turn-1", false)).not.toBeNull();
  });
});
