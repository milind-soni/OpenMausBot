// Real server and the repository's fake Claude: what a stream gets when one thread of a bot changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

it("sends a thread's change alone to a stream that asked for it, the whole bot to one that did not, and saves the turn's bookkeeping together", async () => {
  const fixture = await launchVerificationServer({ ...process.env });
  const { url, dataDir } = fixture.info;
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const snapshot = async (botId: string) => ((await api("GET", "/api/bots?messages=0")).bots as any[]).find((bot) => bot.id === botId);
  const { bot } = await control(["new-bot", "--name", "Maus"]);
  for (const title of ["Second", "Third"]) await api("POST", `/api/bots/${bot.id}/tasks`, { title });
  const known = await snapshot(bot.id);
  expect(known.tasks).toHaveLength(3);
  const threadId = known.tasks.find((task: any) => task.title === "Second").threadId as string;

  const threads = await openSse(`${url}/api/events?frames=thread`, { origin: url });
  let whole = await openSse(`${url}/api/events`, { origin: url });
  const botFrames = (stream: { frames: any[] }) => stream.frames.filter((frame) => frame.kind === "bot" && frame.bot.id === bot.id);
  const turn = async (text: string) => {
    expect((await control(["send", "--bot", bot.id, "--task", threadId, "--text", text])).success).toBe(true);
    expect((await control(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
  };
  try {
    await turn("Reply with one line.");
    await vi.waitFor(() => expect(botFrames(threads).at(-1)?.bot.tasks[0]).toMatchObject({ busy: false, unread: true }), { timeout: 10_000 });
    const partial = botFrames(threads);
    expect(partial.length).toBeGreaterThanOrEqual(5);
    for (const frame of partial) {
      expect(frame.tasksPartial).toBe(true);
      expect(frame.bot.tasks.map((task: any) => task.threadId)).toEqual([threadId]);
      expect(frame.bot).toMatchObject({ id: bot.id, name: "Maus" });
    }

    await vi.waitFor(() => expect(botFrames(whole).length).toBe(partial.length), { timeout: 10_000 });
    for (const frame of botFrames(whole)) {
      expect(frame.tasksPartial).toBeUndefined();
      expect(frame.bot.tasks).toHaveLength(3);
    }

    // The thread frames, applied to what the client knew, are the bot as the server now gives it whole.
    const applied = partial.reduce((seen: any, frame: any) => ({ ...frame.bot, tasks: seen.tasks.map((task: any) => frame.bot.tasks.find((next: any) => next.threadId === task.threadId) ?? task) }), known);
    const now = await snapshot(bot.id);
    expect(applied.tasks).toEqual(now.tasks);
    expect(botFrames(whole).at(-1).bot.tasks).toEqual(now.tasks);

    // The turn's bookkeeping reaches bots.json a moment later, in one piece.
    const saved = () => (JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[])[0].tasks.find((task: any) => task.threadId === threadId);
    await vi.waitFor(() => expect(saved()).toMatchObject({ usage: { turns: 1 }, unread: true }), { timeout: 5_000, interval: 50 });
    expect(Object.keys(saved().resumeCursors)).toHaveLength(1);

    // With no whole-frame stream open the whole bot is not built, so such a stream cannot resume across the gap: it is told to load again.
    const cursor = (whole.frames.find((frame) => frame.kind === "hello").cursor as string).split(":")[0];
    const lastSeq = Math.max(...whole.frames.map((frame) => frame.seq ?? 0));
    whole.close();
    await vi.waitFor(async () => expect((await api("GET", "/api/health")).app).toBe("openmausbot"));
    await turn("And another line.");
    whole = await openSse(`${url}/api/events?since=${cursor}:${lastSeq}`, { origin: url });
    expect((await whole.until((frame) => frame.kind === "hello")).resumed).toBe(false);
    const again = await openSse(`${url}/api/events?frames=thread&since=${cursor}:${lastSeq}`, { origin: url });
    try {
      expect((await again.until((frame) => frame.kind === "hello")).resumed).toBe(true);
      const replayed = await again.until((frame) => frame.kind === "bot" && frame.bot.id === bot.id);
      expect(replayed.tasksPartial).toBe(true);
    } finally { again.close(); }
  } finally {
    threads.close();
    whole.close();
    await fixture.close();
  }
}, 120_000);
