import "./testing/scrub-ambient-omb-env.ts";
import { expect, it, vi } from "vitest";
import { waitForJob } from "../scripts/mcp-server.ts";

it.each(["blocked", "cancelled"])("MCP wait returns %s immediately after the running version changes", async state => {
  const fetcher = vi.fn().mockResolvedValueOnce({ state: "running", since: 1000, version: "v1" })
    .mockResolvedValueOnce({ state, since: 1000, version: "v2" }).mockRejectedValue(new Error("Unexpected additional poll"));
  const progress = vi.fn();
  expect(await waitForJob(fetcher, "selected-thread", { scope: "job", timeoutMs: 1000, onProgress: progress })).toMatchObject({ job: { state, version: "v2" }, timedOut: false });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![0]).toContain("version=v1");
  expect(progress.mock.calls.map(call => call[0].state)).toEqual(["running", state]);
});

it("waits past an already observed terminal version, then stops at the new cancellation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ state: "blocked", since: 1000, version: "seen" })
    .mockResolvedValueOnce({ state: "cancelled", since: 1000, version: "changed" }).mockRejectedValue(new Error("Unexpected additional poll"));
  expect(await waitForJob(fetcher, "selected-thread", { scope: "job", timeoutMs: 1000, after: "seen" })).toMatchObject({ job: { state: "cancelled", version: "changed" }, timedOut: false });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
