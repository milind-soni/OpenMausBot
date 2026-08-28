import { describe, expect, it } from "vitest";

import {
  SSE_STALE_MS,
  isLivePing,
  liveEventsUrl,
  shouldReconnectLiveEvents,
} from "./live-events";

describe("live events URL", () => {
  it("omits the query on a cold connect", () => {
    expect(liveEventsUrl()).toBe("/api/events");
    expect(liveEventsUrl({ screens: true })).toBe("/api/events");
  });

  it("resumes from a cursor and can decline screens", () => {
    expect(liveEventsUrl({ since: "ab12cd34:9" })).toBe("/api/events?since=ab12cd34%3A9");
    expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe(
      "/api/events?since=ab12cd34%3A9&screens=off",
    );
    expect(liveEventsUrl({ screens: false })).toBe("/api/events?screens=off");
  });
});

describe("live events liveness", () => {
  it("reconnects after two missed pings", () => {
    expect(shouldReconnectLiveEvents(0, SSE_STALE_MS - 1)).toBe(false);
    expect(shouldReconnectLiveEvents(0, SSE_STALE_MS)).toBe(true);
  });

  it("treats ping frames as liveness, not chat", () => {
    expect(isLivePing({ kind: "ping" })).toBe(true);
    expect(isLivePing({ kind: "message" })).toBe(false);
  });
});
