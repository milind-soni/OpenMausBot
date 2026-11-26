import { expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { annotateFailedCall } from "../connector-scope-hint.ts";
import { createExecutors } from "./executors.ts";
import { startRun, type RunState } from "./runner.ts";

const slug = "GMAIL_CREATE_EMAIL_DRAFT";
const failure = "The recipient address is invalid";
const frame = (body: unknown) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] } });
const batch = (response: unknown) => frame({ successful: true, data: { results: [{ tool_slug: slug, response }] } });
const withHint = batch({ successful: false, error: failure, data: {} });
annotateFailedCall(withHint, /recipient address is invalid/, () => "Check the recipient before trying again.", [slug]);

async function replay(answer: Record<string, unknown>) {
  const calls: string[] = [];
  const saved: RunState[] = [];
  const workflow = workflowSchema.parse({
    version: 1, summary: "Create a draft and report completion", args: {},
    steps: [
      { id: "draft", kind: "app", label: "Create the draft", app: "gmail", tool: slug, args: { recipient_email: "person@example.com", subject: "Report", body: "Thanks" } },
      { id: "notify", kind: "app", label: "Post completion", app: "slack", tool: "SLACK_SEND_MESSAGE", args: { channel: "C123456", text: "The draft is ready" } },
    ],
  });
  const result = await startRun({ name: "draft", botId: "b", threadId: "t", sha256: "test", workflow }, {
    exec: createExecutors({ botId: "b", cwd: ".", internal: async (_kind, _path, body) => {
      const tool = (body as { params: { arguments: { tools: Array<{ tool_slug: string }> } } }).params.arguments.tools[0]!.tool_slug;
      calls.push(tool);
      return { ok: true, body: tool === slug ? answer : frame({ successful: true, data: { sent: true } }) };
    } }),
    events: { started() {}, ended() {} }, save: (state) => saved.push(structuredClone(state)),
  });
  return { result, calls, saved };
}

it.each([
  { name: "a direct tool failure", answer: frame({ successful: false, error: failure, data: {} }), error: failure },
  { name: "a failure inside a successful batch", answer: batch({ successful: false, error: failure, data: {} }), error: failure },
  { name: "a failure with the connector's appended hint", answer: withHint, error: failure },
  { name: "a shortened result without usable data", answer: batch({ successful: true, data_preview: { id: "preview" } }), error: "too large" },
])("stops before the next action on $name", async ({ answer, error }) => {
  const { result, calls, saved } = await replay(answer);
  expect(result).toMatchObject({ ok: false, error: { type: "step_failed", step: "draft", message: expect.stringContaining(error) } });
  expect(calls).toEqual([slug]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ waiting: { type: "failed", step: "draft" }, results: { draft: { state: "failed" } } });
});

it.each([
  { name: "structured data", answer: batch({ successful: true, data: { id: "draft-1", example: { successful: false, error: "quoted text" } } }) },
  { name: "plain text", answer: frame("Created draft-1") },
])("keeps a successful $name result successful", async ({ answer }) => {
  const { result, calls } = await replay(answer);
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(calls).toEqual([slug, "SLACK_SEND_MESSAGE"]);
});
