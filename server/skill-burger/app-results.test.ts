import { expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { appToolAnswer } from "../connector-app-tools.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { createExecutors } from "./executors.ts";
import { startRun } from "./runner.ts";

const response = (results: Array<{ slug: string; data: unknown }>) => ({
  jsonrpc: "2.0", id: 1,
  result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: {
    results: results.map(({ slug, data }) => ({ tool_slug: slug, response: { successful: true, data } })),
  } }) }] },
});
const row = (id: string, name: string, input: unknown, output?: string): RunMessage => ({
  id, role: "bot", kind: "activity", tool: { name, ok: true, input: JSON.stringify(input), ...(output ? { output } : {}) },
});
const ask: RunMessage = { id: "ask", role: "user", kind: "text", text: "Draft a reply to the latest invoice" };
const recordedData = { messages: [{ threadId: "recorded-thread" }] };
const draftArgs = { to: "person@example.com", subject: "Invoice", body: "Thanks", thread_id: "recorded-thread" };

async function replay(messages: RunMessage[], expected = { tool: "GMAIL_CREATE_EMAIL_DRAFT", field: "thread_id", value: "current-thread" }) {
  const calls: Array<{ tool_slug: string; arguments: Record<string, unknown> }> = [];
  const workflow = draftWorkflow(messages)!.workflow;
  const result = await startRun({ name: "reply", botId: "b", threadId: "t", sha256: "test", workflow }, {
    exec: createExecutors({ botId: "b", cwd: ".", internal: async (kind, _path, body) => {
      expect(kind).toBe("connectors");
      const { tools } = (body as { params: { arguments: { tools: typeof calls } } }).params.arguments;
      calls.push(...tools);
      return { ok: true, body: response(tools.map((tool) => ({
        slug: tool.tool_slug,
        data: tool.tool_slug === "GMAIL_FETCH_EMAILS"
          ? { messages: [{ threadId: tool.arguments.query === "sent" ? "current-sent-thread" : "current-thread" }] }
          : { id: "current-draft" },
      }))) };
    } }),
    events: { started() {}, ended() {} }, save() {},
  });
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(calls.at(-1)).toMatchObject({ tool_slug: expected.tool, arguments: { [expected.field]: expected.value } });
}

it.each(["data", "content", "result"])("pipes a plain app's recorded %s through the actual app executor", async (shape) => {
  const data = { id: "recorded-draft" };
  const frame = appToolAnswer("GMAIL_CREATE_EMAIL_DRAFT", response([{ slug: "GMAIL_CREATE_EMAIL_DRAFT", data }]));
  const result = frame.result as { content: unknown[] };
  const output = toolDetailPreview(shape === "data" ? data : shape === "content" ? result.content : result)!;
  expect(output).toContain("recorded-draft");
  await replay([
    ask,
    row("create", "mcp__composio__gmail_create_draft", draftArgs, output),
    row("update", "mcp__composio__gmail_update_draft", { ...draftArgs, draft_id: "recorded-draft", body: "Revised draft" }),
  ], { tool: "GMAIL_UPDATE_DRAFT", field: "draft_id", value: "current-draft" });
});

it.each([false, true])("pipes the selected multi-execute result with another read present: %s", async (batched) => {
  const tools = [
    ...(batched ? [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "sent" } }] : []),
    { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "invoice" } },
  ];
  const output = response(tools.map((tool) => ({
    slug: tool.tool_slug,
    data: tool.arguments.query === "sent" ? { messages: [{ threadId: "recorded-sent-thread" }] } : recordedData,
  }))).result.content[0]!.text;
  await replay([
    ask,
    row("read", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools }, output),
    row("draft", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: {
      recipient_email: draftArgs.to, subject: draftArgs.subject, body: draftArgs.body, thread_id: draftArgs.thread_id,
    } }] }),
  ]);
});
