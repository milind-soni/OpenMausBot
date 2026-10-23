#!/usr/bin/env -S node --experimental-strip-types
// Opt-in live-model verification with a disposable OpenMausBot server and mail fixture.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { LISTED_TOOLS_MAX } from "../server/mcp-directory.ts";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { measureChatRequests, localTokenizerUrl } from "./measure-chat-tokens.ts";

const MODEL = process.env.OMB_BENCHMARK_MODEL;
if (!MODEL?.trim()) throw new Error("Set OMB_BENCHMARK_MODEL to the exact local model ID");
const runnerUrl = process.env.OMB_BENCHMARK_URL;
if (!runnerUrl?.trim()) throw new Error("Set OMB_BENCHMARK_URL to the local runner endpoint");
const RUNNER = localTokenizerUrl(runnerUrl).href;
const MAIL = [
  { id: "urgent-17", from: "client@example.invalid", subject: "Invoice error: response needed today", body: "Please draft a reply acknowledging the incorrect invoice and promising a corrected copy tomorrow." },
  { id: "newsletter-24", from: "newsletter@example.invalid", subject: "Weekly product newsletter", body: "This week's general product updates. No action requested." },
];

const mcpSource = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'mail_list_inbox', description: 'List synthetic inbox emails and IDs for triage. Read-only.', inputSchema: schema({}) },
  { name: 'mail_archive', description: 'Archive one synthetic inbox email by its ID.', inputSchema: schema({ id: { type: 'string', description: 'Email ID returned by mail_list_inbox' } }, ['id']) },
  { name: 'mail_create_draft', description: 'Create an unsent reply draft to one synthetic inbox email.', inputSchema: schema({ id: { type: 'string', description: 'Email ID returned by mail_list_inbox' }, body: { type: 'string', description: 'Unsent reply text' } }, ['id', 'body']) },
  ...Array.from({ length: ${LISTED_TOOLS_MAX} }, (_, i) => ({ name: 'calendar_reference_' + i, description: 'Look up synthetic calendar reference section ' + i + '; unrelated to mail triage.', inputSchema: schema({ section: { type: 'string' } }) })),
];
const mail = ${JSON.stringify(MAIL)};
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result;
  if (req.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-mail', version: '1' } };
  else if (req.method === 'tools/list') result = { tools };
  else if (req.method === 'tools/call') {
    const name = req.params.name; const args = req.params.arguments ?? {};
    appendFileSync(process.env.MAIL_RECEIPTS, JSON.stringify({ name, args }) + '\n');
    if (name === 'mail_list_inbox') result = { content: [{ type: 'text', text: JSON.stringify(mail) }] };
    else if (name === 'mail_archive' && args.id === 'newsletter-24') result = { content: [{ type: 'text', text: 'Archived newsletter-24' }] };
    else if (name === 'mail_create_draft' && args.id === 'urgent-17') result = { content: [{ type: 'text', text: 'Saved unsent reply draft for urgent-17' }] };
    else result = { content: [{ type: 'text', text: 'Invalid or unrelated synthetic operation' }], isError: true };
  } else result = { content: [{ type: 'text', text: 'Unsupported' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
});`;

const assert = (condition: unknown, detail: string): asserts condition => { if (!condition) throw new Error(detail); };

async function main() {
  const captured: Array<{ request: any; elapsedMs: number; response: string }> = [];
  const proxy = createServer(async (req, res) => {
    const started = performance.now();
    let body = "";
    try {
      for await (const chunk of req) body += chunk;
      const request = body ? JSON.parse(body) : undefined;
      // The compatible driver advertises no effort tiers; this benchmark
      // controls local reasoning explicitly without changing provider settings.
      if (req.url === "/v1/chat/completions" && request) {
        assert(request.model === MODEL, "Unexpected model in quality request");
        request.reasoning_effort = "low";
        body = JSON.stringify(request);
      }
      const upstream = await fetch(`${new URL(RUNNER).origin}${req.url ?? ""}`, {
        redirect: "error",
        method: req.method,
        headers: { "content-type": "application/json", authorization: "Bearer isolated-local-model" },
        ...(body ? { body } : {}),
      });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      let response = "";
      if (upstream.body) for await (const chunk of upstream.body) {
        const bytes = Buffer.from(chunk);
        response += bytes.toString();
        res.write(bytes);
      }
      res.end();
      if (req.url === "/v1/chat/completions") captured.push({ request, elapsedMs: Math.round(performance.now() - started), response });
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Local model forwarding failed" }));
      }
      if (req.url === "/v1/chat/completions") captured.push({ request: null, elapsedMs: Math.round(performance.now() - started), response: String(error) });
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string", "Local proxy did not get a port");
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try { fixture = await launchVerificationServer(); }
  catch (error) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); throw error; }
  const evidencePath = `${fixture.info.logPath}.qwen-quality.json`;
  const receipts = join(fixture.info.dataDir, "mail-receipts.ndjson");
  const evidence: Record<string, unknown> = { model: MODEL, fixture: fixture.info, outcomes: [] };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "isolated-local-model", url: `http://127.0.0.1:${proxyAddress.port}/v1`, model: MODEL } });
    const script = join(fixture.info.dataDir, "synthetic-mail.mjs");
    writeFileSync(script, mcpSource);
    await api("POST", "/api/mcp/servers", { name: "mail", command: process.execPath, args: [script], env: { MAIL_RECEIPTS: receipts }, enabled: true });
    await api("PATCH", "/api/mcp/servers/mail", { enabled: true });
    const { bot } = await control(["new-bot", "--name", "Qwen synthetic triage"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", MODEL]);
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["mail"], description: "Synthetic inbox triage", soul: "Use the mail tools for inbox tasks. Never send email. Draft replies for review." });
    const wait = async () => {
      for (let n = 0; n < 12; n++) {
        const status = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
        if (status.status === "settled" || status.status === "failed") return status;
        if (status.status === "needs-user") {
          const state = await api("GET", "/api/bots");
          const current = state.bots.find((item: any) => item.id === bot.id);
          const card = current.messages.find((item: any) => item.card?.requestId && !item.card.answered)?.card;
          assert(card, "Expected a visible approval card");
          const raw = JSON.stringify(card);
          assert(!raw.includes("mail_send"), "An unexpected send action was requested");
          assert(raw.includes("mail_list_inbox") || raw.includes("mail_archive") || raw.includes("mail_create_draft"), "Unexpected operation requested approval");
          await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: "allow" });
          continue;
        }
      }
      throw new Error("Model exceeded the bounded wait count");
    };
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Hello. Reply briefly."]);
    const hello = await wait();
    assert(hello.status === "settled", `Plain chat did not settle: ${hello.status}`);
    assert(!existsSync(receipts), "Plain chat unexpectedly called mail tools");
    const triageFirstRequest = captured.length;
    (evidence.outcomes as unknown[]).push({ case: "plain", status: hello.status });
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Triage the synthetic inbox: archive the general newsletter, create an unsent reply draft for the urgent invoice email, and tell me what you did. Do not send anything."]);
    const triage = await wait();
    const calls = existsSync(receipts) ? readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "40"]);
    evidence.outcomes = [...(evidence.outcomes as unknown[]), { case: "triage", status: triage.status, calls, messages }];
    assert(triage.status === "settled", `Triage did not settle: ${triage.status}`);
    assert(calls.some((call: any) => call.name === "mail_list_inbox"), "Model did not discover/read inbox");
    assert(calls.some((call: any) => call.name === "mail_archive" && call.args.id === "newsletter-24"), "Model did not archive newsletter");
    assert(calls.some((call: any) => call.name === "mail_create_draft" && call.args.id === "urgent-17" && typeof call.args.body === "string" && call.args.body.trim()), "Model did not draft urgent reply");
    assert(calls.every((call: any) => ["mail_list_inbox", "mail_archive", "mail_create_draft"].includes(call.name)), "Model called unrelated tool");
    const followupFirstRequest = captured.length;
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Thanks. Briefly remind me what happened to the newsletter and whether the urgent reply was sent."]);
    const followup = await wait();
    assert(followup.status === "settled", `Follow-up did not settle: ${followup.status}`);
    const afterFollowup = existsSync(receipts) ? readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    assert(afterFollowup.length === calls.length, "Follow-up unexpectedly called mail tools");
    const requests = captured.map((item) => item.request);
    assert(requests.length > followupFirstRequest && requests.every((request) => request && Array.isArray(request.messages)), "Expected captured requests for all turns");
    const tokenReport = await measureChatRequests(requests, localTokenizerUrl(RUNNER));
    const rawPath = `${fixture.info.logPath}.qwen-requests.json`;
    writeFileSync(rawPath, JSON.stringify(captured, null, 2), { mode: 0o600 });
    evidence.capture = { rawPath, totalRequests: captured.length, triageFirstRequest, followupFirstRequest, elapsedMs: captured.map((item) => item.elapsedMs), tokenReport };
    (evidence.outcomes as unknown[]).push({ case: "followup", status: followup.status, toolCalls: afterFollowup.length });
    console.info(JSON.stringify({ evidencePath, rawPath, logPath: fixture.info.logPath, result: "passed", toolCalls: calls.length, promptTokens: tokenReport.measurements.map((item) => item.inputTokens), sharedPrefixTokens: tokenReport.measurements.map((item) => item.sharedPrefixTokens ?? null) }));
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ evidencePath, logPath: fixture.info.logPath, result: "failed", reason: evidence.error }));
    throw error;
  } finally {
    try { writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
    finally {
      try { await fixture.close(); }
      finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    }
  }
}

await main();
