import { describe, expect, it, vi } from "vitest";

import { releaseEndedGates } from "./release-ended.ts";

describe("releasing the gates of browsers that ended", () => {
  it("releases only an agent-browser session whose daemon has gone and that nothing uses", async () => {
    const release = vi.fn(async () => {});
    const released = await releaseEndedGates({
      sessions: () => ["ended", "running", "held", "chrome-engine", "unknown"],
      env: (session) => (session === "chrome-engine" || session === "unknown" ? null : { AGENT_BROWSER_SESSION: session }),
      running: (session) => session === "running",
      inUse: (session) => session === "held",
      release,
    });
    expect(released).toEqual(["ended"]);
    expect(release.mock.calls).toEqual([["ended"]]);
  });
});
