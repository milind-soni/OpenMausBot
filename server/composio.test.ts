import { describe, expect, it } from "vitest";
import { formatConnectedAppsPrompt, listActiveConnections } from "./composio.ts";
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
});
