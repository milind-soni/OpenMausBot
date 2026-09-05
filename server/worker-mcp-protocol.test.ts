import { describe, expect, it } from "vitest";

import type { ControlClient } from "./control-client.ts";
import type { JsonObject } from "./schema.ts";
import { handleWorkerMcpFrame, WORKER_MCP_TOOLS } from "./worker-mcp-protocol.ts";
import type { WorkerTaskClient, WorkerTaskOp } from "./worker-task-client.ts";

function harness() {
  const calls: Array<{ op: WorkerTaskOp; payload: JsonObject }> = [];
  const client: WorkerTaskClient = {
    configured: true,
    async call(op, payload) {
      calls.push({ op, payload });
      return { text: "ok", content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
  return { client, calls };
}

const toolCall = (name: string, args: JsonObject) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("worker-only MCP protocol", () => {
  it("advertises a stable flat surface without mounting native CUA tools", async () => {
    const { client } = harness();
    const reply = await handleWorkerMcpFrame({ jsonrpc: "2.0", id: 1, method: "tools/list" }, client);
    expect(reply?.result.tools).toEqual(WORKER_MCP_TOOLS);
    expect(WORKER_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "worker_task_propose",
      "worker_task_status",
      "worker_task_run",
      "worker_task_results",
      "worker_computer_describe",
      "worker_computer_call",
    ]);
    for (const tool of WORKER_MCP_TOOLS) {
      expect(Object.values(tool.inputSchema.properties).every((field) => field.type === "string")).toBe(true);
    }
  });

  it("parses manifest JSON before sending it to the control plane", async () => {
    const h = harness();
    await handleWorkerMcpFrame(
      toolCall("worker_task_propose", { manifestJson: '{"version":1,"taskId":"task-1"}' }),
      h.client,
    );
    expect(h.calls).toEqual([{
      op: "propose",
      payload: { manifest: { version: 1, taskId: "task-1" } },
    }]);
  });

  it("keeps CUA arguments out of argv by sending a parsed object to the service", async () => {
    const h = harness();
    await handleWorkerMcpFrame(
      toolCall("worker_computer_call", { tool: "click", argumentsJson: '{"x":12,"y":30}' }),
      h.client,
    );
    expect(h.calls).toEqual([{ op: "computer", payload: { tool: "click", arguments: { x: 12, y: 30 } } }]);
  });

  it("rejects malformed JSON without reaching the service", async () => {
    const h = harness();
    const reply = await handleWorkerMcpFrame(
      toolCall("worker_computer_call", { tool: "click", argumentsJson: "not-json" }),
      h.client,
    );
    expect(reply?.result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("fails closed while the person holds the worker", async () => {
    const h = harness();
    const control = {
      configured: true,
      state: async () => ({ held: true, helpOpen: false }),
    } as ControlClient;
    const reply = await handleWorkerMcpFrame(toolCall("worker_task_status", {}), h.client, control);
    expect(reply?.result.isError).toBe(true);
    expect(reply?.result.content[0].text).toMatch(/person has taken control/);
    expect(h.calls).toHaveLength(0);
  });

  it("preserves image content returned by an approved one-shot call", async () => {
    const client: WorkerTaskClient = {
      configured: true,
      async call() {
        return {
          text: "frame",
          content: [
            { type: "text", text: "frame" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
          isError: false,
        };
      },
    };
    const reply = await handleWorkerMcpFrame(
      toolCall("worker_computer_call", { tool: "get_window_state", argumentsJson: "{}" }),
      client,
    );
    expect(reply?.result.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  });
});
