// A routine run that asks for an approval nobody is there to give: the real server and Claude permission broker, a
// fake engine, and the broker's own fifteen-minute deadline brought forward by a marker file.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

let fixture: VerificationServer | undefined;
let events: SseRecorder | undefined;
let socket: Socket | undefined;
afterEach(async () => {
  socket?.destroy();
  events?.close();
  await fixture?.close();
});

it("waits for the person, tells them at once, and stops saying nobody answered the approval when it went unanswered", async () => {
  fixture = await launchVerificationServer({ ...process.env, OMB_TEST_APPROVAL_CLOCK: "1", FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir } = fixture.info;
  const dump = join(dataDir, "claude-turn.json");
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const bot = (await runControlOmb(["new-bot", "--name", "Inbox bot", "--url", url]) as any).bot;
  // Each launch writes where the test can find its permission broker.
  const wrapper = join(dataDir, "claude-dumping.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump)};`,
    `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const { routine } = await api("POST", "/api/routines", {
    name: "Inbox brief", prompt: "Search my inbox and summarise it.", botId: bot.id, timeoutMinutes: 5,
    schedule: { type: "cron", expression: "0 7 * * *", timeZone: "Europe/London" },
  });
  events = await openSse(`${url}/api/events`, { origin: url });
  const notified = () => events!.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification as { kind: string; title: string; body: string });
  const run = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.routineId === routine.id);

  await api("POST", `/api/routines/${routine.id}/run`);
  await expect.poll(() => existsSync(dump), { timeout: hostTimeout(15_000) }).toBe(true);
  const launch = JSON.parse(readFileSync(dump, "utf8"));
  expect(launch.argv).toContain("--permission-prompt-tool");
  socket = connect(launch.mcpConfig.mcpServers.ogb.args.at(-1));
  await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
  const answers: any[] = [];
  socket.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) answers.push(JSON.parse(line)); });
  socket.write(`${JSON.stringify({ t: "ask", id: randomUUID(), tool: "mcp__composio__COMPOSIO_SEARCH_TOOLS", input: { queries: [{ use_case: "read my inbox" }] } })}\n`);

  await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "waiting", attention: "Waiting for your approval to use COMPOSIO_SEARCH_TOOLS" });
  await expect.poll(notified, { timeout: hostTimeout(15_000) }).toContainEqual(expect.objectContaining({
    kind: "approval", title: "Inbox bot needs approval", body: "Inbox brief: Waiting for your approval to use COMPOSIO_SEARCH_TOOLS",
  }));
  const waiting = await run();
  const chat = async () => (await api("GET", `/api/threads/${waiting.resultsThreadId ?? bot.threadId}/messages?limit=100`)).messages as any[];
  const copy = (await chat()).find((message: any) => message.automation?.runId === waiting.id && message.kind === "options");
  expect(copy).toMatchObject({ card: { tool: "mcp__composio__COMPOSIO_SEARCH_TOOLS", requestType: "permission" }, automation: { needsYou: true } });

  // Nobody answers: the broker's own deadline passes.
  writeFileSync(join(dataDir, "expire-approvals"), "");
  const stopped = "Stopped: nobody answered the approval to use COMPOSIO_SEARCH_TOOLS";
  await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "failed", error: stopped });
  await expect.poll(notified, { timeout: hostTimeout(15_000) }).toContainEqual(expect.objectContaining({ kind: "routine-failed", body: `Inbox brief: ${stopped}` }));
  await expect.poll(async () => (await chat()).find((message) => message.id === copy.id)?.card?.answered, { timeout: hostTimeout(15_000) }).toBeTruthy();
  await expect.poll(async () => (await chat()).find((message) => message.automation?.runId === waiting.id && message.kind === "text")?.text, { timeout: hostTimeout(15_000) })
    .toBe(`This run didn't finish: ${stopped}`);
  await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id)?.busy, { timeout: hostTimeout(15_000) }).toBe(false);
  expect(answers.some((answer) => answer.behavior === "deny")).toBe(true);
}, hostTimeout(90_000));
