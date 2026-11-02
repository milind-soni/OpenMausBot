// The chat runtime answers its own tool gate at Full access and under
// "Always allow this session", so the safety floor is applied there too.
//
// Nothing here runs a shell command. The fixture MCP server's `exec` tool
// only appends the command it was HANDED to a file in a temporary directory,
// which is how a test tells "the call went through" from "it was refused".
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { bindSafetyFloor } from "../safety-floor-gate.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { createChatToolApproval } from "./chat-tool-approval.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const WIPE = "rm -rf /";
/** The server's platform, given wherever the floor is expected to act, so
 * the suite says the same thing on a Windows runner. */
const HOST = "linux" as const;
const BLOCKED = "Blocked by the safety floor: recursive delete of the filesystem root";

const MCP_SCRIPT = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const [directory] = process.argv.slice(2);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const schema = { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false };
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  } else if (request.method === "tools/list") {
    reply(request.id, { tools: [{ name: "exec", description: "Records the command it is handed. Runs nothing.", inputSchema: schema }] });
  } else if (request.method === "tools/call") {
    appendFileSync(join(directory, "handed.ndjson"), JSON.stringify(request.params.arguments.command) + "\\n");
    reply(request.id, { content: [{ type: "text", text: "Recorded, not run." }] });
  } else if (request.id !== undefined && request.method === "ping") reply(request.id, {});
});
`;

interface ChatRequest { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }

const cleanups: Array<() => Promise<void>> = [];
// A shell that already exports the switch must not turn the floor on here.
beforeEach(() => { delete process.env.OMB_SAFETY_FLOOR; });
afterEach(async () => {
  bindSafetyFloor(() => ({}));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sse(response: ServerResponse, delta: unknown, finishReason: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

/** A chat-completions provider that asks for one `shell_exec` call per
 * command, in order, then answers; and the fixture MCP server it calls. */
async function fixture(commands: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "omb-chat-floor-"));
  const requests: ChatRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
      return;
    }
    let data = "";
    // Only a turn's POST carries a body; the Ollama probe GETs /api/version first (ollama-context.ts).
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const part of request) data += part.toString();
    requests.push(JSON.parse(data) as ChatRequest);
    const command = commands[requests.length - 1];
    if (command === undefined) return sse(response, { content: "Done." }, "stop");
    sse(response, { content: null, tool_calls: [{
      index: 0, id: `call_${requests.length}`, type: "function",
      function: { name: "shell_exec", arguments: JSON.stringify({ command }) },
    }] }, "tool_calls");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const helper = join(directory, "mcp.mjs");
  writeFileSync(helper, MCP_SCRIPT);
  const instance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: "Safety floor fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" },
    environment: { FIXTURE_CHAT_KEY: "fixture-credential-5b1d7c0e" },
  });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  const integrations: SendTurnInput["integrations"] = { custom: { shell: { command: process.execPath, args: [helper, directory], env: {} } } };
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(directory);
  });
  return {
    instance, recorder, requests, threadId,
    /** Every command the fixture tool was handed, in order. */
    handed: (): string[] => existsSync(join(directory, "handed.ndjson"))
      ? readFileSync(join(directory, "handed.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string)
      : [],
    start: (input: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({
      threadId, botId: "bot-floor", text: "Tidy up.", model: "fixture-model", integrations, ...input,
    }),
    completed: () => recorder.until((event) => event.type === "turn.completed"),
    cards: () => recorder.events.filter((event) => event.type === "request.opened"),
    notices: () => recorder.events.flatMap((event) => event.type === "runtime.notice" ? [event.message] : []),
    /** What the model was handed back for one call, in the last request it
     * received (every request resends the transcript before it). */
    toolResult: (callId: string) => requests.at(-1)!.messages.filter((message) => message.role === "tool" && message.tool_call_id === callId).map((message) => String(message.content)),
    decisions: async () => {
      await flushDecisionLog(DATA_DIR);
      return readDecisions(DATA_DIR, 500).filter((row) => row.threadId === threadId);
    },
  };
}

describe("the safety floor in the chat runtime", () => {
  it("changes nothing while it is off: Full access still answers every call", async () => {
    const f = await fixture([WIPE]);
    await f.start({ approvalMode: "full" });
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.handed()).toEqual([WIPE]);
    expect(f.notices()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
  });

  it("is not applied on a Windows server: Full access answers every call, as with the setting off", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, "win32");
      const f = await fixture([WIPE]);
      await f.start({ approvalMode: "full" });
      expect(await f.completed()).toMatchObject({ ok: true });
      expect(f.handed()).toEqual([WIPE]);
      expect(f.cards()).toEqual([]);
      expect(f.notices()).toEqual([]);
      expect(await f.decisions()).toEqual([]);
    } finally {
      warnings.mockRestore();
    }
  });

  it("refuses a never-list command at Full access, and still runs everything else", async () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, HOST);
    const f = await fixture(["ls -la", WIPE, "git commit -m 'rm -rf /'"]);
    await f.start({ approvalMode: "full" });
    const done = await f.completed();
    // the wipe never reached the tool; its neighbours did, with no card
    expect(f.handed()).toEqual(["ls -la", "git commit -m 'rm -rf /'"]);
    expect(f.cards()).toEqual([]);
    expect(f.notices()).toEqual([BLOCKED]);
    // the model is told why, in the refused call's own result and nowhere else
    expect(f.toolResult("call_2")).toEqual([expect.stringContaining(BLOCKED)]);
    expect(f.toolResult("call_1")).toEqual([expect.stringContaining("Recorded, not run.")]);
    expect(f.toolResult("call_3")).toEqual([expect.stringContaining("Recorded, not run.")]);
    expect(f.recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_2", ok: false }));
    expect(done).toMatchObject({ ok: false, denials: ["shell_exec"] });
    expect(await f.decisions()).toEqual([
      expect.objectContaining({ botId: "bot-floor", tool: "shell_exec", decision: "auto-denied", source: "safety-floor", rule: "delete-root" }),
    ]);
  });

  it("refuses a command the floor cannot read, because this gate has no card to show at Full access", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), () => ({ read: false }), HOST);
      const f = await fixture(["npm test"]);
      await f.start({ approvalMode: "full" });
      expect(await f.completed()).toMatchObject({ ok: false, denials: ["shell_exec"] });
      expect(f.handed()).toEqual([]);
      expect(f.notices()).toEqual(["Blocked by the safety floor: a command it could not read"]);
      expect(f.toolResult("call_1")).toEqual([expect.stringContaining("could not read")]);
      expect(await f.decisions()).toEqual([expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule: "unreadable" })]);
    } finally {
      errors.mockRestore();
    }
  });

  it("does not override a card a person answers", async () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, HOST);
    const f = await fixture([WIPE]);
    await f.start({ approvalMode: "ask" });
    const card = await f.recorder.until((event) => event.type === "request.opened");
    expect(card).toMatchObject({ requestType: "permission", tool: "shell_exec" });
    expect(f.handed()).toEqual([]);
    expect(await f.instance.adapter.respondToRequest(f.threadId, card.requestId!, { behavior: "allow" })).toBe("allowed-once");
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.handed()).toEqual([WIPE]);
    expect(f.notices()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
  });

  it("refuses it under \"Always allow this session\" too, where the grant would have answered", async () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, HOST);
    const f = await fixture(["ls", WIPE, "pwd"]);
    await f.start({ approvalMode: "ask" });
    const card = await f.recorder.until((event) => event.type === "request.opened");
    expect(card).toMatchObject({ tool: "shell_exec", allowSession: true });
    await f.instance.adapter.respondToRequest(f.threadId, card.requestId!, { behavior: "allow", always: true });
    await f.completed();
    // one card for the whole turn: the grant covered the rest, except the wipe
    expect(f.cards()).toHaveLength(1);
    expect(f.handed()).toEqual(["ls", "pwd"]);
    expect(f.notices()).toEqual([BLOCKED]);
    expect(await f.decisions()).toEqual([expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule: "delete-root" })]);
  });
});

describe("the chat tool gate", () => {
  it("says whether a session grant would answer an ask without a card", () => {
    const granted = new Set(["kept"]);
    const noop = () => {};
    const approval = createChatToolApproval({ signal: new AbortController().signal, granted, open: noop, resolved: noop, openQuestion: noop, resolvedQuestion: noop });
    expect(approval.covered("kept")).toBe(true);
    expect(approval.covered("other")).toBe(false);
    expect(approval.covered(undefined)).toBe(false);
    // a guest's turn uses none of the owner's grants
    const guest = createChatToolApproval({ signal: new AbortController().signal, open: noop, resolved: noop, openQuestion: noop, resolvedQuestion: noop });
    expect(guest.covered("kept")).toBe(false);
    approval.close();
    guest.close();
  });
});
