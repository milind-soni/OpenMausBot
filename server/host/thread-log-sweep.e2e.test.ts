import { appendFileSync, existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { AGE_MS, sweepThreadLogs } from "./thread-log-sweep.ts";

// Cloud homes, where this runs, are Linux; Windows refuses a rename over a log the server may hold open.
it.skipIf(process.platform === "win32")("a conversation whose logs were trimmed and cut still resumes its engine session and keeps its transcript", async () => {
  // Each turn's engine exits once it answers, so the next turn relaunches it with --resume.
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_EXIT_AFTER_TURN: "1" });
  try {
    const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok).toBe(true);
      return response.json() as Promise<any>;
    };
    const argv = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).argv as string[];
    const { bot } = await api("POST", "/api/bots", { name: "Log keeper" });
    const turn = async (text: string) => {
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"])).status).toBe("settled");
    };
    await turn("First: remember the word HERON.");
    const saved = (JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as any[]).find((b) => b.id === bot.id);
    const cursor = Object.values(saved?.resumeCursors ?? {})[0] as string;
    expect(typeof cursor).toBe("string");

    // A month of other activity after the session started, then a month of quiet.
    const events = join(fixture.info.dataDir, "events", `${bot.threadId}.ndjson`);
    const native = join(fixture.info.dataDir, "native", `${bot.threadId}.ndjson`);
    const filler = `${JSON.stringify({ eventId: "f", provider: "claudeAgent", threadId: bot.threadId, createdAt: new Date().toISOString(), type: "turn.started", pad: "z".repeat(600) })}\n`;
    appendFileSync(events, filler.repeat(6_000));
    appendFileSync(native, `${JSON.stringify({ at: new Date().toISOString(), dir: "in", source: "claude", msg: { pad: "z".repeat(600) } })}\n`.repeat(6_000));
    const then = new Date(Date.now() - AGE_MS - 24 * 60 * 60_000);
    for (const file of [events, native]) utimesSync(file, then, then);
    const before = statSync(events).size + statSync(native).size;

    const result = await sweepThreadLogs({ dataDir: fixture.info.dataDir, mode: "on", cap: 1, cut: true, threads: () => new Map([[bot.threadId, { busy: false }]]) });
    expect(result.trimmed).toBe(2);
    expect(result.cut).toBe(2);
    expect(existsSync(native)).toBe(false);
    expect(statSync(events).size).toBeLessThan(before / 100);
    expect(readFileSync(events, "utf8")).toContain(cursor);

    await turn("Second: what was the word?");
    const launched = argv();
    expect(launched.indexOf("--resume")).toBeGreaterThan(-1);
    expect(launched[launched.indexOf("--resume") + 1]).toBe(cursor);
    const messages = (await api("GET", "/api/bots")).bots.find((b: any) => b.id === bot.id).messages;
    const said = JSON.stringify(messages);
    expect(said).toContain("remember the word HERON");
    expect(said).toContain("what was the word?");
  } finally {
    await fixture.close();
  }
}, 120_000);
