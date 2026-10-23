#!/usr/bin/env -S node --experimental-strip-types
// Opt-in discovery check: real CUA definitions, synthetic executor, isolated app.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { localTokenizerUrl, measureChatRequests } from "./measure-chat-tokens.ts";

const runnerUrl = process.env.OMB_BENCHMARK_URL;
if (!runnerUrl?.trim()) throw new Error("Set OMB_BENCHMARK_URL to the local runner endpoint");
const RUNNER = localTokenizerUrl(runnerUrl).href;
const MODEL = process.env.OMB_BENCHMARK_MODEL;
if (!MODEL?.trim()) throw new Error("Set OMB_BENCHMARK_MODEL to the exact local model ID");
const CATALOG = process.env.OMB_COMPUTER_CATALOG_FILE;
const assert = (condition: unknown, detail: string): asserts condition => { if (!condition) throw new Error(detail); };

const mcpSource = String.raw`
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const tools = JSON.parse(readFileSync(process.env.CUA_CATALOG, 'utf8'));
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result;
  if (req.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cua-reference-only', version: '1' } };
  else if (req.method === 'tools/list') result = { tools };
  else if (req.method === 'tools/call') {
    appendFileSync(process.env.CUA_CALLS, JSON.stringify({ name: req.params.name, arguments: req.params.arguments }) + '\n');
    result = { content: [{ type: 'text', text: 'Synthetic fixture refused every desktop action' }], isError: true };
  } else result = { content: [{ type: 'text', text: 'Unsupported' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
});`;

async function main() {
  assert(CATALOG, "Set OMB_COMPUTER_CATALOG_FILE to a local read-only CUA tool catalog JSON export");
  const sourceCatalog = JSON.parse(readFileSync(CATALOG, "utf8"));
  assert(Array.isArray(sourceCatalog) && sourceCatalog.some((tool) => tool.name === "get_desktop_state"), "Read-only CUA catalog export is unavailable");
  const captured: any[] = [];
  const proxy = createServer(async (req, res) => {
    let body = "";
    try {
      for await (const chunk of req) body += chunk;
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
      if (req.url === "/v1/chat/completions") captured.push({ request: JSON.parse(body), response });
    } catch {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Local model forwarding failed" }));
      }
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string", "Local proxy did not get a port");
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try { fixture = await launchVerificationServer(); }
  catch (error) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); throw error; }
  const evidencePath = `${fixture.info.logPath}.qwen-computer-discovery.json`;
  const rawPath = `${fixture.info.logPath}.qwen-computer-requests.json`;
  const receipts = join(fixture.info.dataDir, "refused-computer-calls.ndjson");
  const evidence: Record<string, unknown> = { model: MODEL, fixture: fixture.info, catalogTools: sourceCatalog.length };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "isolated-local-model", url: `http://127.0.0.1:${proxyAddress.port}/v1`, model: MODEL } });
    const catalogPath = join(fixture.info.dataDir, "cua-catalog.json");
    writeFileSync(catalogPath, JSON.stringify(sourceCatalog));
    const scriptPath = join(fixture.info.dataDir, "cua-reference.mjs");
    writeFileSync(scriptPath, mcpSource);
    await api("POST", "/api/mcp/servers", { name: "cua_reference", command: process.execPath, args: [scriptPath], env: { CUA_CATALOG: catalogPath, CUA_CALLS: receipts }, enabled: true });
    await api("PATCH", "/api/mcp/servers/cua_reference", { enabled: true });
    const { bot } = await control(["new-bot", "--name", "Qwen CUA discovery"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", MODEL]);
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["cua_reference"], description: "Research a synthetic computer tool catalog", soul: "Discover the tool the user requests and read its full instructions. Never execute a computer action." });
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Find the tool to take a screenshot of the full display. Read its full instructions and tell me its exact name; do not execute it."]);
    let status: any;
    for (let attempt = 0; attempt < 12; attempt++) {
      status = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
      if (["settled", "failed", "needs-user"].includes(status.status)) break;
    }
    const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "40"]);
    const toolNames = messages.messages.filter((item: any) => item.tool?.name).map((item: any) => item.tool.name);
    const lastReply = [...messages.messages].reverse().find((item: any) => item.role === "bot" && !item.tool && typeof item.text === "string" && !item.text.startsWith("[digest]"))?.text ?? "";
    writeFileSync(rawPath, JSON.stringify(captured, null, 2), { mode: 0o600 });
    const tokenReport = await measureChatRequests(captured.map((item) => item.request), localTokenizerUrl(RUNNER));
    evidence.result = { status: status?.status, toolNames, lastReply, actionReceipts: existsSync(receipts) ? readFileSync(receipts, "utf8") : "", tokenReport, rawPath };
    assert(status?.status === "settled", `Discovery did not settle: ${status?.status}`);
    assert(toolNames.includes("cua_reference_search_tools"), "Model did not search CUA catalog");
    assert(toolNames.includes("cua_reference_describe_tool"), "Model did not request full tool instructions");
    assert(lastReply.includes("get_desktop_state"), "Model did not identify get_desktop_state");
    assert(!existsSync(receipts), "Model attempted an underlying desktop action");
    console.info(JSON.stringify({ result: "passed", evidencePath, rawPath, requests: captured.length, toolNames, promptTokens: tokenReport.measurements.map((item) => item.inputTokens) }));
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ result: "failed", evidencePath, reason: evidence.error }));
    throw error;
  } finally {
    try {
      writeFileSync(rawPath, JSON.stringify(captured, null, 2), { mode: 0o600 });
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    }
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
