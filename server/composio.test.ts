import { afterEach, describe, expect, it, vi } from "vitest";
import { formatConnectedAppsPrompt, invalidateActiveConnectionsCache, listActiveConnections } from "./composio.ts";
import type { AppConfig } from "./config.ts";

describe("composio active connections & prompt formatting", () => {
  it("degrades gracefully to empty array when Composio is unconfigured", async () => {
    const cfg: AppConfig = {};
    const conns = await listActiveConnections(cfg);
    expect(conns).toEqual([]);
  });

  it("degrades gracefully to empty string when Composio is unconfigured", async () => {
    const cfg: AppConfig = {};
    const prompt = await formatConnectedAppsPrompt(cfg);
    expect(prompt).toBe("");
  });

  describe("when Composio hangs", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      invalidateActiveConnectionsCache();
    });

    it("gives up on the prompt block after the budget instead of stalling the turn", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
      const cfg: AppConfig = { composio: { key: "ck_test" } };
      const prompt = formatConnectedAppsPrompt(cfg);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(prompt).resolves.toBe("");
    });
  });
});
