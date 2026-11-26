import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import { armBackground, BACKGROUND_WAIT_MS, backgroundWaitNote, cloudUnreachableTooLong, neverSent } from "./away.ts";

const node = (more: Partial<HandoffView> = {}): HandoffView => ({ id: "n", rootId: "r", threadId: "t", botId: "link-cloud-atlas", key: "k", text: "", createdAt: 0, status: "queued",
  result: "", reported: false, executions: 0, kind: "assignment", restarts: 0, mode: "work", reply: "resume", ...more } as HandoffView);

describe("work no person waits on, for a Cloud that cannot be reached", () => {
  it("waits up to the bound while the Cloud has not taken it, and its words hold for any reason the Cloud could not be reached", () => {
    expect(cloudUnreachableTooLong(node(), "My Cloud", true, BACKGROUND_WAIT_MS - 1)).toBeNull();
    expect(cloudUnreachableTooLong(node(), "My Cloud", true, BACKGROUND_WAIT_MS)).toBe("My Cloud could not be reached for 6 hours (asleep, off or not connected), so this was not sent there. Work no person waits on does not wake it.");
    expect(cloudUnreachableTooLong(node(), "My Cloud", false, BACKGROUND_WAIT_MS), "the Cloud took it: it is not given up here").toBeNull();
    expect(cloudUnreachableTooLong(node({ restart: "rerun", restarts: 1 }), "My Cloud", true, BACKGROUND_WAIT_MS)).toBeNull();
    expect(backgroundWaitNote("My Cloud")).not.toContain("delivered when it is back");
    expect(neverSent(node({ executions: 1 }))).toBe(false);
  });
});

describe("after an app restart", () => {
  it("waiting background work is looked at again when its wait is over, not at the next unrelated kick, once per node", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const kicks: number[] = [];
      armBackground([{ id: "restart-a", createdAt: 1_000 }, { id: "restart-b", createdAt: 5_000 }], 3_000, 10_000, () => kicks.push(Date.now()));
      armBackground([{ id: "restart-a", createdAt: 1_000 }], 3_000, 10_000, () => kicks.push(-1));
      vi.advanceTimersByTime(8_000 + 49);
      expect(kicks).toHaveLength(0);
      vi.advanceTimersByTime(2);
      expect(kicks).toHaveLength(1);
      vi.advanceTimersByTime(4_000);
      expect(kicks).toHaveLength(2);
      expect(kicks).not.toContain(-1);
    } finally { vi.useRealTimers(); }
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("./link.ts", import.meta.url), "utf8")).toMatch(/tidy\(\): void \{ prune\(\); expire\(\); sweep\(\); if \(state\?\.role === "dialer"\) armBackground\(/u);
  });
});
