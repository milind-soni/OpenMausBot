// The JSON-RPC entry the harness proxy reaches: tools/list (filtered to what this bot may run) and tools/call
// (validate → per-bot verdict → run). The turn's capability must still be live before and after the call.
import { HIGHLEVEL_INSTRUCTIONS } from "./instructions.ts";
import type { HighLevelClient } from "./client.ts";
import { HIGHLEVEL_TOOLS, highlevelErrorResult, highlevelToolCallProblem, isHighLevelToolName, runHighLevelTool, type HighLevelTool, type HighLevelToolResult, type HighLevelWriteRecord } from "./tools.ts";

export const HIGHLEVEL_INTERNAL_MCP_PATH = "/api/internal/highlevel/mcp";

export interface HighLevelRpcDeps {
  client: HighLevelClient;
  assertActive(): void;
  /** The per-bot verdict for one tool name; a refusal's text is returned to the bot as a failed call. */
  authorize(name: string): { ok: true } | { ok: false; text: string };
  /** A successful write: the handler records it in the bot's activity. */
  onWrite?(record: HighLevelWriteRecord): void;
}

export type HighLevelToolsList = { tools: HighLevelTool[]; instructions: string };

export async function highlevelRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: HighLevelRpcDeps,
): Promise<HighLevelToolsList | HighLevelToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: HIGHLEVEL_TOOLS.filter((tool) => deps.authorize(tool.name).ok), instructions: HIGHLEVEL_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported highlevel method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = highlevelToolCallProblem(params.name, args);
  if (problem || !isHighLevelToolName(params.name)) return highlevelErrorResult(problem ?? "Unknown HighLevel tool.", { code: "invalid_input" });
  const name = params.name;
  deps.assertActive();
  const verdict = deps.authorize(name);
  if (!verdict.ok) return highlevelErrorResult(verdict.text, { code: "refused" });
  const { result, write } = await deps.client.withActiveCall(deps.assertActive, () => runHighLevelTool(deps.client, name, args as Record<string, unknown>));
  deps.assertActive();
  if (write && !result.isError) deps.onWrite?.(write);
  return result;
}
