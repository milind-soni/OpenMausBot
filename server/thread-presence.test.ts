import { afterEach, describe, expect, it } from "vitest";

import { forgetPresence, onThreadSeen, personAsks, sawThread, seenWithin } from "./thread-presence.ts";

afterEach(() => forgetPresence());

describe("thread presence", () => {
  it("tells listeners when a person opens or reads a conversation, but not when they ask in it", () => {
    const heard: string[] = [];
    const stop = onThreadSeen((threadId) => heard.push(threadId));
    sawThread("opened", 1_000);
    personAsks.set("asked", 2_000);
    expect(heard).toEqual(["opened"]);
    // An ask is still a sighting.
    expect(seenWithin("asked", 10, 2_005)).toBe(true);
    stop();
    sawThread("later");
    expect(heard).toEqual(["opened"]);
  });

  it("keeps recording sightings when a listener throws", () => {
    const stop = onThreadSeen(() => { throw new Error("listener failed"); });
    expect(() => sawThread("t", 5_000)).not.toThrow();
    expect(seenWithin("t", 10, 5_005)).toBe(true);
    stop();
  });
});
