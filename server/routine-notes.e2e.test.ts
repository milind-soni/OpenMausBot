// Phase 4 part 4: a run's "Note for next run:" line reaches the next run of
// the same routine, through the real fake-engine turn. Same shape as the
// continuity e2e.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("carries a bot's note for the next run into that run's prompt", async () => {
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Queue checked, all clear.\nNote for next run: the archive folder is empty, skip it.", "Second run done."]),
  });
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result as any;
  };
  try {
    expect((await runControlOmb(["doctor"], { env }) as any).ok).toBe(true);
    const { bot } = await runControlOmb(["new-bot", "--name", "Notes fixture"], { env }) as any;
    const { routine } = await api("POST", "/api/routines", {
      name: "Notes fixture", prompt: "Check the queue.", botId: bot.id, enabled: false, continuity: true,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const run = async () => {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => ((await api("GET", "/api/routines")).runs as any[]).find((item) => item.id === run.id)?.status, { timeout: 30_000 }).toBe("completed");
      const finished = ((await api("GET", "/api/routines")).runs as any[]).find((item) => item.id === run.id);
      return { finished, prompt: JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt) as string };
    };
    const first = await run();
    expect(first.finished.nextNote).toBe("the archive folder is empty, skip it.");
    expect(first.prompt).not.toContain("previous-run-note");
    const second = await run();
    expect(second.prompt).toContain("<previous-run-note>");
    expect(second.prompt).toContain("the archive folder is empty, skip it.");
  } finally {
    await fixture.close();
  }
}, 120_000);
