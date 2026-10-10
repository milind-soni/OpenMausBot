import { describe, expect, it } from "vitest";

import { Endpointer } from "./endpointer";

const QUIET = 0.002;
const LOUD = 0.2;

function feed(endpointer: Endpointer, rms: number, ms: number) {
  const events: string[] = [];
  for (let t = 0; t < ms; t += 20) {
    const event = endpointer.push(rms);
    if (event !== "none") events.push(event);
  }
  return events;
}

describe("Endpointer", () => {
  it("ignores loud audio during calibration (the bot's playback tail)", () => {
    const e = new Endpointer({ endpointMs: 600 });
    expect(feed(e, LOUD, 200)).toEqual([]);
    expect(e.inSpeech).toBe(false);
  });

  it("starts on sustained speech and ends after the silence endpoint", () => {
    const e = new Endpointer({ endpointMs: 600 });
    feed(e, QUIET, 400);
    expect(feed(e, LOUD, 600)).toEqual(["start"]);
    expect(feed(e, QUIET, 580)).toEqual([]);
    expect(feed(e, QUIET, 40)).toEqual(["end"]);
    expect(e.inSpeech).toBe(false);
  });

  it("does not start on a single click", () => {
    const e = new Endpointer({ endpointMs: 600 });
    feed(e, QUIET, 400);
    expect(feed(e, LOUD, 40)).toEqual([]);
    expect(feed(e, QUIET, 1000)).toEqual([]);
  });

  it("discards a turn too short to be speech", () => {
    const e = new Endpointer({ endpointMs: 400, minSpeechMs: 300 });
    feed(e, QUIET, 400);
    expect(feed(e, LOUD, 120)).toEqual(["start"]);
    expect(feed(e, QUIET, 400)).toEqual(["discard"]);
  });

  it("keeps a soft word ending inside the turn (hysteresis)", () => {
    const e = new Endpointer({ endpointMs: 400 });
    feed(e, QUIET, 400);
    feed(e, LOUD, 400);
    // well under the entry threshold, above the stay threshold
    expect(feed(e, 0.009, 1000)).toEqual([]);
    expect(e.inSpeech).toBe(true);
  });

  it("never auto-ends in manual mode, but enforces the length limit", () => {
    const e = new Endpointer({ endpointMs: 0, maxUtteranceMs: 2000 });
    feed(e, QUIET, 400);
    expect(feed(e, LOUD, 200)).toEqual(["start"]);
    expect(feed(e, QUIET, 1000)).toEqual([]);
    expect(feed(e, QUIET, 1000)).toEqual(["limit"]);
  });
});
