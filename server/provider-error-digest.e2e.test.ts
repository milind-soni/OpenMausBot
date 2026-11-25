import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const REJECTIONS = [
  { status: 429, reason: "quota", state: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 11h32m" },
  { status: 503, reason: "server_error", state: "UNAVAILABLE", message: "This model is currently experiencing high demand" },
] as const;

it.each(REJECTIONS)("a provider HTTP $status ends the turn as failed, with the provider's words in the chat and the digest, and its status in the server log", async ({ status, reason, state, message }) => {
  let chatRequests = 0;
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    for await (const _ of req) { /* drained */ }
    chatRequests += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify([{ error: { code: status, message, status: state } }]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const closeUpstream = async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  const fixture = await launchVerificationServer().catch(async (error) => {
    await closeUpstream();
    throw error;
  });
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const saved = await fetch(`${fixture.info.url}/api/config`, {
      method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url },
      body: JSON.stringify({ openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } }),
    });
    expect(saved.ok).toBe(true);
    const { bot } = await control(["new-bot", "--name", `Provider ${status}`]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "ping"])).success).toBe(true);
    const said = `upstream HTTP ${status}`;
    // The harness retries a failed turn once on its own, so the first turn is read from the top, not as the thread's tail.
    const firstFailedTurn = async () => {
      const page = await fetch(`${fixture.info.url}/api/threads/${encodeURIComponent(bot.activeTaskId)}/messages?limit=50`, { headers: { origin: fixture.info.url } });
      const rows = (await page.json() as any).messages as any[];
      const failed = rows.findIndex((row) => row.kind === "activity" && row.tool?.terminal === true && row.tool.ok === false);
      const digest = failed === -1 ? undefined : rows.slice(failed + 1).find((row) => row.kind === "digest");
      return digest ? { failure: rows[failed], digest } : undefined;
    };
    await expect.poll(firstFailedTurn, { timeout: 60_000, interval: 250 }).toBeDefined();
    const { failure, digest } = (await firstFailedTurn())!;

    expect(chatRequests).toBeGreaterThan(0);
    expect(failure.tool.name).toContain(said);
    expect(failure.tool.name).toContain(message);
    expect(digest.turnSucceeded).toBe(false);
    expect(digest.digest.error).toContain(said);
    expect(digest.digest.error).toContain(message.slice(0, 40));
    expect(digest.text).toContain(`turn failed: ${said}`);
    expect(digest.text).not.toContain("synthetic-fixture-key");
    const log = readFileSync(fixture.info.logPath, "utf8");
    expect(log).toMatch(new RegExp(`\\[omb-turn\\] thread=\\S+ turn=\\S+ failed: ${reason} HTTP ${status}\\n`));
    expect(log).not.toContain(message);
    expect(log).not.toContain("synthetic-fixture-key");
  } finally {
    await fixture.close();
    await closeUpstream();
  }
}, 120_000);
