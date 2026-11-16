import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { createRoomJobs, parallelRoomJobsEnabled } from "./room-jobs.ts";

// Room members work side by side unless the server opts out.
describe("parallelRoomJobsEnabled", () => {
  it("is on when the config leaves it out", () => {
    expect(parallelRoomJobsEnabled({} as AppConfig)).toBe(true);
    expect(parallelRoomJobsEnabled({ features: {} } as AppConfig)).toBe(true);
  });

  it("stays off when the config sets it to false", () => {
    expect(parallelRoomJobsEnabled({ features: { parallelRoomJobs: false } } as AppConfig)).toBe(false);
  });
});

describe("laneBulletin", () => {
  const rooms: Record<string, { name: string; bulletin: string }> = {
    "room-thread": { name: "Studio", bulletin: "  Synthetic data only.  " },
    "quiet-thread": { name: "Quiet", bulletin: "" },
  };
  const store = { groupByThread: (threadId: string) => rooms[threadId] } as unknown as Store;
  const lanes: Record<string, string> = { lane: "room-thread", "quiet-lane": "quiet-thread" };
  const { laneBulletin } = createRoomJobs({ store, coordinator: { active: () => [] }, cfg: {} as AppConfig,
    operations: () => [], speakerOf: () => undefined, laneRoomThread: n => lanes[n.threadId] });

  it("carries the room's bulletin into a job running beside it", () => {
    expect(laneBulletin({ botId: "b", threadId: "lane" })).toBe('Room bulletin of "Studio" (shared instructions for everyone):\nSynthetic data only.');
  });

  it("adds nothing for other threads or a room without a bulletin", () => {
    expect(laneBulletin({ botId: "b", threadId: "work" })).toBe("");
    expect(laneBulletin({ botId: "b", threadId: "quiet-lane" })).toBe("");
  });
});
