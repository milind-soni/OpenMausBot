import { toolData } from "../connected-reads.ts";
import { parseMcpResponse } from "../connector-tools-list.ts";
import type { ToolInvoker } from "./workflow.ts";

type RelayResult = { status: number; bytes: Uint8Array; transportSessionId?: string };
export interface WorkflowConnectorDeps {
  authorize(tool: string): Promise<boolean>;
  accountFor?(tool: string): string;
  relay(payload: Record<string, unknown>, session: string | undefined, signal: AbortSignal): Promise<RelayResult>;
}

export function createWorkflowConnector(deps: WorkflowConnectorDeps): ToolInvoker {
  let session: string | undefined;
  let opened = false;
  return async (tool, input, signal) => {
    signal.throwIfAborted();
    if (!await deps.authorize(tool)) throw new Error("Permission to use the connected tool was refused");
    if (!opened) {
      const initial = await deps.relay({ jsonrpc: "2.0", id: "minimum-ai-init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-minimum-ai", version: "1" } } }, undefined, signal);
      if (initial.status !== 200) throw new Error(`Connected apps initialization returned HTTP ${initial.status}`);
      session = initial.transportSessionId;
      const ready = await deps.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, session, signal);
      if (ready.status < 200 || ready.status >= 300) throw new Error(`Connected apps setup returned HTTP ${ready.status}`);
      opened = true;
    }
    signal.throwIfAborted();
    const account = deps.accountFor?.(tool);
    const answer = await deps.relay({ jsonrpc: "2.0", id: "minimum-ai-call", method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: tool, arguments: input, ...(account ? { account } : {}) }], sync_response_to_workbench: false } } }, session, signal);
    if (answer.status !== 200) throw new Error(`Connected tool returned HTTP ${answer.status}`);
    const frame = parseMcpResponse(new TextDecoder().decode(answer.bytes), "minimum-ai-call");
    // This call always uses multi-execute. A generic direct-tool response cannot prove that this action ran.
    const result = frame?.result as { content?: Array<{ text?: unknown }> } | undefined;
    const text = result?.content?.find((part) => typeof part.text === "string")?.text;
    let body: { data?: { results?: unknown } } | undefined;
    try { body = typeof text === "string" ? JSON.parse(text) as typeof body : undefined; } catch { /* toolData reports the malformed response */ }
    if (body && !Array.isArray(body.data?.results)) throw new Error(`${tool}: multi-execute returned no result list`);
    return toolData(tool, frame);
  };
}
