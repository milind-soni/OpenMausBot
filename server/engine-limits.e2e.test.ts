import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("a bot's turn reads its accounts' usage limits through its own capability, and nothing else may", async () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-engine-limits-"));
  const gate = join(folder, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  try {
    const request = (path: string, init: RequestInit = {}) => fetch(fixture.info.url + path, { ...init, headers: { "content-type": "application/json", origin: fixture.info.url, ...init.headers } });
    const { bot } = await (await request("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) })).json() as { bot: { id: string; threadId: string } };
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "How much Claude is left?", "--url", fixture.info.url]);
    let token = "";
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);

    expect((await request("/api/internal/engine-limits", { headers: { authorization: "Bearer wrong" } })).status).toBeGreaterThanOrEqual(400);
    const answer = await request("/api/internal/engine-limits", { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    const { text } = await answer.json() as { text: string };
    const accounts = JSON.parse(text).accounts as Array<{ engine: string; status: string; windows: unknown[]; why?: string }>;
    const claude = accounts.find((account) => account.engine === "claudeAgent");
    // The Claude Code login is never read for usage, so Claude reports no limits; a refused turn still fails over.
    expect(claude, text).toMatchObject({ status: "unsupported", windows: [] });
    expect(claude!.why, text).toBeTruthy();
    writeFileSync(gate, "finish");
  } finally {
    await fixture.close();
    await removeTempDir(folder);
  }
});
