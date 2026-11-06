// @devs end to end: a fixture server with the synthetic Claude CLI and a fake MausBot team endpoint on loopback. A
// message that tags @devs sends exactly one report, with the bot's report_bug summary or, when the bot never calls it,
// with the server's own facts; secrets are masked, the conversation itself never goes, and the person sees the line.
// Then the loop closes: the server asks the team about its reports (every 1.5 s here), the person's message shows each
// one's status, and once the team says it is fixed in the version this server runs, one line says so, once.
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
type BugReport = { id: string; status: string; fixedIn?: string; running?: boolean };
type Row = { id: string; role: string; kind: string; text?: string; tool?: { name: string; ok?: boolean; output?: string }; bugReport?: BugReport };
/** What the fake team says about every report it is asked about, and every question it got. */
const team = { status: "received", fixedIn: null as string | null, notify: true };
const questions: Array<{ body: { installId: string; ids: string[] }; signed: boolean }> = [];
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;

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
      if (request.method === "POST" && request.url === "/api/bug-reports/status" && request.headers["content-type"] === "application/json") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { installId: string; ids: string[] };
        questions.push({ body, signed: "x-omb-cloud-signature" in request.headers });
        const reports = body.ids.map((id) => ({ id, status: team.status, fixedIn: team.status === "fixed" ? team.fixedIn : null }));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reports, notify: team.notify }));
        return;
      }
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
    OMB_DEVS_STATUS_MS: "1500",
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

it("shows each report's status on the message that sent it, and once the team fixes it in the version this server runs, says so once", async () => {
  const asked = (await rows()).filter((row) => row.role === "user" && row.text?.startsWith("@devs"));
  expect(asked).toHaveLength(2);
  await until(async () => (await rows()).filter((row) => row.bugReport?.status === "received").length === 2, 20_000);
  expect((await rows()).filter((row) => row.bugReport).map((row) => row.bugReport)).toEqual([{ id: "report-1", status: "received" }, { id: "report-2", status: "received" }]);
  // The server's own install asks about its own open reports, unsigned (this is not a Cloud home).
  await until(() => questions.some((question) => question.body.ids.length === 2), 20_000);
  expect(questions.at(-1)!.body.ids.sort()).toEqual(["report-1", "report-2"]);
  expect(questions.at(-1)!.body.installId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(questions.every((question) => !question.signed)).toBe(true);
  // The team marks both fixed in this very version.
  Object.assign(team, { status: "fixed", fixedIn: VERSION });
  const line = `notice: Fixed in ${VERSION}. Want to try again?`;
  await until(async () => (await rows()).filter((row) => row.kind === "activity" && row.tool?.name === line).length === 2, 20_000);
  expect((await rows()).filter((row) => row.role === "user" && row.bugReport).map((row) => row.bugReport))
    .toEqual([{ id: "report-1", status: "fixed", fixedIn: VERSION, running: true }, { id: "report-2", status: "fixed", fixedIn: VERSION, running: true }]);
  expect((await rows()).find((row) => row.tool?.name === line)!.bugReport).toEqual({ id: expect.stringMatching(/^report-[12]$/), status: "fixed", fixedIn: VERSION, running: true });
  // One notification for each, about Scout's chat.
  const notifications = (await api("GET", "/api/notifications")).body.notifications as Array<{ kind: string; botName: string; threadId: string; body: string }>;
  expect(notifications.filter((entry) => entry.body === `Fixed in ${VERSION}. Want to try again?`).map(({ kind, botName, threadId }) => ({ kind, botName, threadId })))
    .toEqual([{ kind: "notice", botName: "Scout", threadId: scout.threadId }, { kind: "notice", botName: "Scout", threadId: scout.threadId }]);
  // Never again: several more rounds pass, and no more questions are asked about reports told.
  const after = questions.length;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect((await rows()).filter((row) => row.tool?.name === line)).toHaveLength(2);
  expect(questions.length).toBe(after);
}, hostTimeout(120_000));
