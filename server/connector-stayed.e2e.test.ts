// A move that leaves a connector behind says so, end to end: this computer's server and a Cloud home, main's own wiring
// between them, and My Cloud's fake engine. The person is told when the move ends, and once in the first conversation with
// each other bot that could have used it, in words of the server's own, not a model's. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const phase = () => (existsSync(fx.journalFile) ? (JSON.parse(readFileSync(fx.journalFile, "utf8")) as { phase: string }).phase : null);

beforeAll(async () => {
  // A PATH with no uvx: this Cloud lacks it, as the image did before it carried uv.
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-stayed-${randomBytes(8).toString("hex")}`, env: { OMB_ENVIRONMENT_LABEL: "Mac mini", PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) } });
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

type Row = { kind?: string; role: string; text?: string; tool?: { name?: string } };
const rows = async (threadId: string) => (await fx.onCloud("GET", `/api/threads/${threadId}/messages?limit=500`)).body.messages as Row[];
const lines = (messages: Row[]) => messages.flatMap((message) => [message.text ?? "", message.tool?.name ?? ""]).filter((text) => text.includes(" stayed on Mac mini"));

it("what stayed on the computer is told when the move ends and in the first conversation with each bot, and the move never says everything is here", async () => {
  const { local, onCloud } = fx;
  // A bot nobody touched yet doesn't move: each has a job.
  const made = async (name: string) => {
    const bot = (await local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string };
    expect((await local("PATCH", `/api/bots/${bot.id}`, { description: `${name}'s job` })).status).toBe(200);
    return bot;
  };
  await made("Scout");
  await made("Pip");
  const narrow = await made("Narrow");
  for (const server of [{ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }, { name: "easy", command: "uvx", args: ["mcp-email-server", "stdio"] }, { name: "idle", command: "uvx", args: ["mcp-server-time"] }]) {
    expect((await local("POST", "/api/mcp/servers", server)).status).toBe(201);
    if (server.name !== "idle") expect((await local("PATCH", `/api/mcp/servers/${server.name}`, { enabled: true })).status).toBe(200);
  }
  expect((await local("PATCH", `/api/bots/${narrow.id}`, { mcpServers: [] })).status).toBe(200);

  fx.account.state = { ...fx.account.state, deviceId: "device-mini", machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  for (const until = Date.now() + 150_000; phase() !== "done" && Date.now() < until;) { await fx.oneHome.kick(); if (phase() !== "done") await sleep(500); }
  expect(phase(), `${existsSync(fx.journalFile) ? readFileSync(fx.journalFile, "utf8") : "no journal"}\n${fx.logs().slice(-3000)}`).toBe("done");

  // What the move's own line names (src/lib/cloud-send.ts), where it said "Everything from this computer is here".
  expect(fx.oneHome.view()).toMatchObject({ phase: "done", stayed: [{ name: "fetch", needs: "uvx" }, { name: "easy" }] });

  // One bot says all of it in its own chat, and the person is told outside the chat too.
  const bots = (await onCloud("GET", "/api/bots")).body.bots as Array<{ id: string; name: string; threadId: string }>;
  const threads = new Map(bots.map((bot) => [bot.id, bot.threadId]));
  const told = await Promise.all(bots.map(async (bot) => ({ bot, said: lines(await rows(bot.threadId)) })));
  const speakers = told.filter(({ said }) => said.length);
  expect(speakers).toHaveLength(1);
  expect(speakers[0]!.said.join("\n")).toContain("fetch stayed on Mac mini when your bots moved to My Cloud, so bots here can't use it. It needs uvx, which My Cloud doesn't have.");
  expect(speakers[0]!.said.join("\n")).toContain("easy stayed on Mac mini when your bots moved to My Cloud, so bots here can't read or send mail through it.");
  expect(speakers[0]!.said.join("\n"), "one switched off was not working anyway").not.toContain("idle");
  const notices = (await onCloud("GET", "/api/notifications")).body.notifications as Array<{ kind: string; body: string }>;
  expect(notices.filter((notice) => notice.kind === "notice" && notice.body.includes("stayed on Mac mini"))).toHaveLength(1);

  // A person's first line to another bot that could have used it: a row, once, in that conversation.
  const other = bots.find((bot) => bot.id !== speakers[0]!.bot.id && bot.id !== narrow.id)!;
  expect(other, JSON.stringify({ bots: bots.map((bot) => [bot.id, bot.name]), speaker: speakers[0]!.bot.name, narrow: narrow.id })).toBeDefined();
  const say = async (bot: { id: string }, text: string) => {
    const threadId = threads.get(bot.id)!;
    expect((await onCloud("POST", `/api/bots/${bot.id}/messages`, { text, threadId })).status).toBe(202);
    await expect.poll(async () => (await rows(threadId)).some((row) => row.role === "user" && row.text === text), { timeout: 30_000, interval: 100 }).toBe(true);
  };
  await say(other, "emails abrufen");
  await expect.poll(async () => lines(await rows(other.threadId)).length, { timeout: 30_000, interval: 100 }).toBe(2);
  await expect.poll(async () => (await onCloud("GET", "/api/bots")).body.bots.every((entry: { busy?: boolean }) => !entry.busy), { timeout: 60_000, interval: 200 }).toBe(true);
  await say(other, "noch einmal");
  await sleep(500);
  expect(lines(await rows(other.threadId)), "once per bot").toHaveLength(2);

  // A bot that never had it hears nothing, and the one that said it at the move does not repeat it.
  await say(narrow, "hello");
  await say(speakers[0]!.bot, "hello");
  await sleep(500);
  expect(lines(await rows(threads.get(narrow.id)!))).toEqual([]);
  expect(lines(await rows(speakers[0]!.bot.threadId))).toHaveLength(speakers[0]!.said.length);
}, hostTimeout(240_000));
