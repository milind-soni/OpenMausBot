import { describe, expect, it } from "vitest";

import { createCloudComputerCounters } from "./cloud-computer-counters.ts";
import { buildDevsReport } from "./devs-report.ts";

describe("cloud computer counts", () => {
  it("keeps numbers and waiting time per computer, and says them in one line each, most recent first", () => {
    let at = Date.UTC(2026, 10, 14, 10, 0, 0);
    const counters = createCloudComputerCounters(() => at);
    counters.count("bx_aaaaaaaa", "wakes", 41_200);
    counters.count("bx_aaaaaaaa", "unanswered");
    counters.count("bx_aaaaaaaa", "unanswered");
    counters.count("bx_aaaaaaaa", "resent");
    at += 60_000;
    counters.count("bx_bbbbbbbb", "restoreWaits", 312_000);
    counters.count("bx_bbbbbbbb", "restarts", 20_000);
    expect(counters.lines()).toEqual([
      "bx_bbbbbbbb: 1 waits on a disk restore (312s in all), 1 restarts (20s in all); last 2026-11-14T10:01:00.000Z",
      "bx_aaaaaaaa: 1 waits for an answer after waking (41s in all), 2 calls unanswered, 1 calls sent again; last 2026-11-14T10:00:00.000Z",
    ]);
    expect(counters.snapshot("bx_aaaaaaaa")).toMatchObject({ unanswered: 2, lostAnswers: 0 });
  });

  it("keeps at most twenty computers, dropping the one heard from longest ago", () => {
    let at = 0;
    const counters = createCloudComputerCounters(() => at++);
    for (let index = 0; index < 21; index++) counters.count(`bx_${String(index).padStart(8, "0")}`, "wakes");
    expect(counters.lines()).toHaveLength(20);
    expect(counters.snapshot("bx_00000000")).toBeNull();
  });

  it("reach the bug report's diagnostics, and only when there is something to say", () => {
    const input = {
      installId: "install", appVersion: "0.0.0", platform: "darwin", os: "darwin", runsOn: "desktop", node: "v0", uptimeSeconds: 60, now: 0,
      threadId: "thread", messageId: "message", where: "a chat", message: "@devs the computer got stuck", bots: [], problems: [], log: [], noSummary: "none",
    } as unknown as Parameters<typeof buildDevsReport>[0];
    expect(buildDevsReport(input, []).diagnostics).not.toContain("Cloud computers since the server started");
    const report = buildDevsReport({ ...input, cloudComputers: ["bx_aaaaaaaa: 52 calls unanswered; last 2026-11-14T10:00:00.000Z"] }, []);
    expect(report.diagnostics).toContain("## Cloud computers since the server started\nbx_aaaaaaaa: 52 calls unanswered");
  });
});
