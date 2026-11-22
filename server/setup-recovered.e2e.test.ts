// The "needs setup" mark end to end, through server/index.ts's runtime.error and turn.completed handling: a fixture
// server with the synthetic Claude CLI, whose sign-in lapses (a file exists) and comes back (the file is gone). A
// conversation that met the lapsed sign-in marks its bot "dead"; a later turn of the same engine in another
// conversation clears it, without that conversation running again.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Task = { threadId: string; activity?: string; busy?: boolean };
type Bot = { id: string; activity?: string; busy?: boolean; tasks?: Task[] };

let fixture: VerificationServer;
let script = "";
let url = "";
const signedOut = () => join(script, "signed-out");

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const bot = async (id: string) => ((await api("GET", "/api/bots")).body.bots as Bot[]).find((entry) => entry.id === id)!;
const task = async (id: string, threadId: string) => (await bot(id)).tasks!.find((entry) => entry.threadId === threadId)!;
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
async function send(botId: string, threadId: string, text: string): Promise<void> {
  const sent = await api("POST", `/api/bots/${botId}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => {
    const current = await task(botId, threadId);
    return !current.busy && current.activity !== "working";
  });
}

beforeAll(async () => {
  script = mkdtempSync(join(tmpdir(), "omb-setup-recovered-e2e-"));
  writeFileSync(join(script, "reply.txt"), "Done.");
  fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_SIGNED_OUT_FILE: signedOut(),
    FAKE_CLAUDE_REPLY_FILE: join(script, "reply.txt"),
  });
  url = fixture.info.url;
  // A turn that fails would otherwise be carried on by another engine; this test is about the mark itself.
  expect((await api("PUT", "/api/config", { automaticRecovery: { enabled: false } })).status).toBe(200);
}, hostTimeout(120_000));

afterAll(async () => {
  await fixture?.close();
  if (script) rmSync(script, { recursive: true, force: true });
});

it("clears a bot's needs-setup mark once another of its conversations runs on the signed-in engine again", async () => {
  const created = await api("POST", "/api/bots", { name: "Quill" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.bot.id as string;
  const failedThread = (created.body.bot.mainThreadId ?? created.body.bot.threadId) as string;
  const other = await api("POST", `/api/bots/${id}/tasks`, { title: "Later" });
  expect(other.status, JSON.stringify(other.body)).toBeLessThan(300);
  const laterThread = other.body.task.threadId as string;

  writeFileSync(signedOut(), "");
  await send(id, failedThread, "SIGNED_OUT_TURN_6Q");
  await until(async () => (await task(id, failedThread)).activity === "dead");
  expect((await bot(id)).activity).toBe("dead");

  rmSync(signedOut());
  await send(id, laterThread, "SIGNED_IN_AGAIN_6Q");
  await until(async () => (await task(id, failedThread)).activity !== "dead");
  expect((await task(id, failedThread)).activity ?? "idle").toBe("idle");
  expect((await bot(id)).activity).not.toBe("dead");
}, hostTimeout(120_000));
