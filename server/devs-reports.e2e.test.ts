// @devs end to end: a fixture server with the synthetic Claude CLI and a fake MausBot team endpoint on loopback. A
// message that tags @devs sends exactly one report, with the bot's report_bug summary or, when the bot never calls it,
// with the server's own facts; secrets are masked, the conversation itself never goes, and the person sees the line.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const KEY = `sk-ant-${"k".repeat(40)}`;
const TOKEN = `ghp_${"t".repeat(36)}`;
type Report = Record<string, string>;
type Row = { id: string; role: string; kind: string; text?: string; tool?: { name: string; ok?: boolean; output?: string } };

let endpoint: Server;
const received: Report[] = [];
let fixture: VerificationServer;
let script = "";
let url = "";
let scout: { id: string; threadId: string };

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const rows = async () => (await api("GET", `/api/threads/${scout.threadId}/messages?limit=200`)).body.messages as Row[];
const idle = async () => ((await api("GET", "/api/bots")).body.bots as Array<{ id: string; busy?: boolean; activity?: string }>)
  .filter((bot) => bot.id === scout.id).every((bot) => !bot.busy && bot.activity !== "working");
const plan = (calls: unknown[], reply: string) => {
  writeFileSync(join(script, "tool-calls.json"), JSON.stringify(calls));
  writeFileSync(join(script, "reply.txt"), reply);
};
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
async function say(text: string, reply: string) {
  const sent = await api("POST", `/api/bots/${scout.id}/messages`, { text, threadId: scout.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => await idle() && (await rows()).some((row) => row.role === "bot" && row.kind === "text" && row.text === reply));
}

beforeAll(async () => {
  endpoint = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/api/bug-reports" || request.headers["content-type"] !== "application/json") {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found." }));
        return;
      }
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Report);
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: `report-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  script = mkdtempSync(join(tmpdir(), "omb-devs-e2e-"));
  plan([], "Hello.");
  fixture = await launchVerificationServer({
    ...process.env,
    OMB_BUG_REPORT_URL: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/api/bug-reports`,
    FAKE_CLAUDE_TOOL_CALLS_FILE: join(script, "tool-calls.json"),
    FAKE_CLAUDE_REPLY_FILE: join(script, "reply.txt"),
  });
  url = fixture.info.url;
  expect((await api("PATCH", "/api/config", { profile: { name: "Ada", email: "Ada@Example.com" } })).status).toBe(200);
  const created = await api("POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = { id: created.body.bot.id, threadId: created.body.bot.mainThreadId ?? created.body.bot.threadId };
}, hostTimeout(120_000));

afterAll(async () => {
  await fixture?.close();
  await new Promise((resolve) => endpoint?.close(resolve));
  if (script) rmSync(script, { recursive: true, force: true });
});

it("sends one report with the bot's report_bug summary and the facts, redacted, and the person sees where it went", async () => {
  plan([
    { name: "Bash", input: { command: "convert in.png out.webp" }, ok: false, output: `convert: command not found (OPENAI_API_KEY=${KEY})` },
    { name: "report_bug", server: "agents", input: { went_wrong: "Pictures never load", you_saw: `Bash failed: convert: command not found; token ${TOKEN}`, steps: "1. Attach a picture\n2. Send it" } },
  ], "I sent your report to the team.");
  await say(`@devs pictures never load (my key is ${KEY})`, "I sent your report to the team.");
  await until(() => received.length === 1);

  const [report] = received;
  expect(Object.keys(report!).sort()).toEqual(["appVersion", "contact", "contactEmail", "description", "diagnostics", "installId", "platform", "source"]);
  expect(report).toMatchObject({ source: "bot", contactEmail: "ada@example.com", contact: "ada@example.com" });
  expect(report!.installId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(report!.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(report!.platform).toMatch(/^(darwin|linux|win32) \w+, self-hosted server$/);
  expect(report!.description.split("\n")[0]).toBe(`pictures never load (my key is «redacted ${KEY.length} chars»)`);
  expect(report!.description).toContain("Scout's summary: Pictures never load");
  expect(report!.description).toContain("Steps to reproduce: 1. Attach a picture\n2. Send it");
  expect(report!.diagnostics).toContain(`Conversation: ${scout.threadId}`);
  expect(report!.diagnostics).toContain("Bot: Scout");
  expect(report!.diagnostics).toMatch(/Engine: Verification fixture \(claude\), model /);
  expect(report!.diagnostics).toContain("tool Bash failed: convert: command not found");
  expect(report!.diagnostics).toContain("Summary from a bot: yes, by Scout (report_bug)");
  const whole = JSON.stringify(report);
  for (const secret of [KEY, TOKEN]) expect(whole).not.toContain(secret);
  expect(whole).not.toContain("I sent your report to the team.");
  expect(whole).not.toContain("convert in.png out.webp");

  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { prompt: unknown };
  expect(JSON.stringify(dump.prompt)).toContain("this message tags @devs, so it is a bug report for the MausBot team");
  const line = "Sent to the MausBot team (report report-1). Milind and Omkar get it by email and will reply to ada@example.com.";
  await until(async () => (await rows()).some((row) => row.kind === "activity" && row.tool?.name === `notice: ${line}`), 20_000);
  const tool = (await rows()).find((row) => row.kind === "activity" && row.tool?.name === "report_bug");
  expect(tool?.tool?.output).toContain(line);
}, hostTimeout(120_000));

it("still sends the report, with the server's facts, when the bot never calls report_bug, and only once", async () => {
  plan([], "Sorry, I am not sure what happened.");
  await say("@devs the send button froze again", "Sorry, I am not sure what happened.");
  await until(() => received.length === 2, 30_000);
  const report = received[1]!;
  expect(report.description.split("\n")[0]).toBe("the send button froze again");
  expect(report.description).toContain("No summary from a bot: the bot did not call report_bug.");
  expect(report.diagnostics).toContain("tool Bash failed: convert: command not found");
  expect(report.diagnostics).toContain("notice: Sent to the MausBot team (report report-1)");
  const line = "Sent to the MausBot team (report report-2). Milind and Omkar get it by email and will reply to ada@example.com.";
  await until(async () => (await rows()).some((row) => row.kind === "activity" && row.tool?.name === `notice: ${line}`), 20_000);

  plan([], "Noted.");
  await say("a message without the tag, and `@devs` in code", "Noted.");
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect(received).toHaveLength(2);
}, hostTimeout(120_000));
