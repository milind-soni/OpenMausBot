import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// A check the app's restart cut short is left in check-work.json. The real server must start with it there, whatever
// state it is in, end a real one with one line and the notice it held, and never post anything for one it cannot trust.

type Line = { kind?: string; tool?: { name?: string } };

async function withFixture(test: (f: { url: string; dataDir: string; botId: string; threadId: string; boot(): Promise<() => Promise<void>> }) => Promise<void>) {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const running: ChildProcess[] = [];
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Nib", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const boot = async () => {
      const log = openSync(logPath, "a", 0o600);
      const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(process.env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
      });
      closeSync(log);
      running.push(child);
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(`the server exited:\n${readFileSync(logPath, "utf8").slice(-4_000)}`);
        return fetch(`${url}/api/health`).then((response) => response.ok).catch(() => false);
      }, { timeout: 20_000, interval: 150 }).toBe(true);
      return () => waitForExit(child, { signal: "SIGTERM" });
    };
    await test({ url, dataDir, botId: bot.id, threadId: bot.activeTaskId, boot });
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|TypeError|store: change listener threw/);
  } finally {
    for (const child of running) await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
  }
}

const notChecked = async (url: string, threadId: string) => ((await request(`/api/threads/${threadId}/messages`, {}, url) as { messages: Line[] }).messages)
  .filter((message) => message.kind === "activity" && /Not checked/.test(message.tool?.name ?? ""));
const doneNotices = async (url: string, threadId: string) => ((await request("/api/notifications", {}, url) as { notifications: Array<Record<string, unknown>> }).notifications)
  .filter((entry) => entry.kind === "done" && (entry.threadId ?? entry.thread_id) === threadId);

it("starts with an unfinished check left over, ends it with one line and the held notice, clears the file, and posts nothing more on the next start", () => withFixture(async (f) => {
  const file = join(f.dataDir, "check-work.json");
  writeFileSync(file, JSON.stringify([{ botId: f.botId, threadId: f.threadId, answer: "The draft that was being checked." }]));
  let stop = await f.boot();
  await expect.poll(async () => (await notChecked(f.url, f.threadId)).length, { timeout: 15_000 }).toBe(1);
  expect((await notChecked(f.url, f.threadId))[0]!.tool!.name).toBe("notice: Not checked: the app restarted");
  await expect.poll(async () => (await doneNotices(f.url, f.threadId)).length, { timeout: 10_000 }).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  await stop();
  stop = await f.boot();
  expect(await notChecked(f.url, f.threadId)).toHaveLength(1);
  expect(await doneNotices(f.url, f.threadId)).toHaveLength(1);
  await stop();
}), 120_000);

it("starts, and posts nothing, when check-work.json is half-written, the wrong shape, or names a bot or conversation that is gone", () => withFixture(async (f) => {
  const file = join(f.dataDir, "check-work.json");
  for (const contents of [
    `[{"botId":"${f.botId}","threadId":"${f.threadId}","ans`,
    JSON.stringify({ botId: f.botId, threadId: f.threadId, answer: "x" }),
    JSON.stringify([{ botId: 5, threadId: f.threadId, answer: "x" }, null, "text"]),
    JSON.stringify([{ botId: "no-such-bot", threadId: f.threadId, answer: "x" }, { botId: f.botId, threadId: "no-such-thread", answer: "x" }]),
  ]) {
    writeFileSync(file, contents);
    const stop = await f.boot();
    expect(await notChecked(f.url, f.threadId), contents).toEqual([]);
    expect(await doneNotices(f.url, f.threadId), contents).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")), contents).toEqual([]);
    await stop();
  }
}), 180_000);
