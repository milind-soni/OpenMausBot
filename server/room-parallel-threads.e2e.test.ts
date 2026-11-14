// The fake Claude CLI in `slow` mode holds every reply until the gate file exists, so "still working" is a state the test controls.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireGroup } from "../shared/wire.ts";

type Message = { role: string; kind: string; text?: string; tool?: { name?: string; ok?: boolean }; from?: { botId: string } };

describe.skipIf(process.platform === "win32")("parallel room threads", () => {
  it("runs threads side by side, stops one thread alone, and queues a shared bot thread by thread", async () => {
    const gateDir = mkdtempSync(join(tmpdir(), "omb-parallel-threads-"));
    const gate = join(gateDir, "finish.gate");
    const fixture = await launchVerificationServer({
      ...process.env,
      FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
    });
    const { url } = fixture.info;
    const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json() as any;
      expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
      return result;
    };
    const fleet = async () => await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; busy?: boolean }>; groups: WireGroup[] };
    const room = async (id: string) => (await fleet()).groups.find((group) => group.id === id)!;
    const task = async (roomId: string, threadId: string) => (await room(roomId)).tasks?.find((item) => item.threadId === threadId);
    const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as Message[];
    const replied = async (threadId: string, botId: string) =>
      (await messages(threadId)).some((message) => message.role === "bot" && message.kind === "text" && message.from?.botId === botId);
    const newThread = async (roomId: string, title: string) => (await api("POST", `/api/groups/${roomId}/tasks`, { title })).group.threadId as string;
    const send = (roomId: string, threadId: string, text: string) => api("POST", `/api/groups/${roomId}/messages`, { text, threadId });
    const POLL = { timeout: 30_000, interval: 100 };

    try {
      const xena = (await control("new-bot", "--name", "Xena")).bot;
      const yuri = (await control("new-bot", "--name", "Yuri")).bot;

      const solo = (await control("new-channel", "--name", "Solo room", "--members", xena.id)).channel;
      const soloFirst = solo.activeTaskId as string;
      const soloSecond = await newThread(solo.id, "Second");
      const soloThird = await newThread(solo.id, "Third");
      await send(solo.id, soloFirst, "First thread work");
      await expect.poll(async () => (await task(solo.id, soloFirst))?.busyBotId, POLL).toBe(xena.id);
      await send(solo.id, soloSecond, "Second thread work");
      await send(solo.id, soloThird, "Third thread work");
      for (const threadId of [soloSecond, soloThird]) {
        await expect.poll(async () => (await messages(threadId)).some((message) =>
          message.kind === "activity" && message.tool?.name?.includes("is finishing another conversation")), POLL).toBe(true);
        expect((await task(solo.id, threadId))?.working).toBe(true);
      }
      expect((await room(solo.id)).tasks?.filter((item) => item.busyBotId === xena.id).map((item) => item.threadId)).toEqual([soloFirst]);

      writeFileSync(gate, "finish");
      for (const threadId of [soloFirst, soloSecond, soloThird]) {
        // on failure, name what the thread holds instead (a skip, a stale chip)
        await expect.poll(() => replied(threadId, xena.id), POLL).toBe(true).catch(async (error) => {
          throw new Error(`${threadId}: ${JSON.stringify((await messages(threadId)).map((m) => [m.role, m.kind, m.text?.slice(0, 80), m.tool?.name]))}\n${error}`);
        });
      }
      await expect.poll(async () => (await room(solo.id)).tasks?.some((item) => item.working || item.busyBotId), POLL).toBe(false);
      for (const threadId of [soloSecond, soloThird]) {
        const transcript = await messages(threadId);
        expect(transcript.filter((message) => message.kind === "activity" && /skipped/.test(message.tool?.name ?? ""))).toEqual([]);
        expect(transcript.find((message) => message.tool?.name?.includes("is finishing another conversation"))?.tool?.ok).toBe(true);
      }

      rmSync(gate);
      const pair = (await control("new-channel", "--name", "Pair room", "--members", `${xena.id},${yuri.id}`)).channel;
      const pairFirst = pair.activeTaskId as string;
      const pairSecond = await newThread(pair.id, "Yuri's thread");
      await Promise.all([
        send(pair.id, pairFirst, "@Xena take the first thread"),
        send(pair.id, pairSecond, "@Yuri take the second thread"),
      ]);
      await expect.poll(async () => {
        const current = await room(pair.id);
        return Object.fromEntries((current.tasks ?? []).map((item) => [item.threadId, item.busyBotId ?? null]));
      }, POLL).toEqual({ [pairFirst]: xena.id, [pairSecond]: yuri.id });
      const both = await fleet();
      expect(both.bots.filter((bot) => bot.id === xena.id || bot.id === yuri.id).every((bot) => bot.busy)).toBe(true);

      await api("POST", `/api/groups/${pair.id}/interrupt`, { threadId: pairFirst });
      await expect.poll(async () => (await task(pair.id, pairFirst))?.working, POLL).toBe(false);
      expect(await task(pair.id, pairSecond)).toMatchObject({ working: true, busyBotId: yuri.id });

      writeFileSync(gate, "finish");
      await expect.poll(() => replied(pairSecond, yuri.id), POLL).toBe(true);
      await expect.poll(async () => (await task(pair.id, pairSecond))?.working, POLL).toBe(false);
      expect(existsSync(gate)).toBe(true);
    } finally {
      if (!existsSync(gate)) writeFileSync(gate, "finish");
      await fixture.close();
      rmSync(gateDir, { recursive: true, force: true });
    }
  }, 120_000);
});
