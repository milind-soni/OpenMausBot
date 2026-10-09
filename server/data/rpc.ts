// One JSON-RPC request from harness-mcp-proxy data, answered with its MCP
// `result`: tools/list is the catalog plus the dialect instructions;
// tools/call checks the arguments against the advertised schema, then runs
// the tool on the bot's connection. The turn's capability must still be live
// before and after anything touches the database, like the computer's rpc.
import { DATA_INSTRUCTIONS } from "./instructions.ts";
import { DATA_TOOLS, dataErrorResult, dataToolCallProblem, runDataTool, type DataContext, type DataToolResult } from "./tools.ts";

/** Where harness-mcp-proxy data posts: `/api/internal/${kind}/mcp`. */
export const DATA_INTERNAL_MCP_PATH = "/api/internal/data/mcp";

export interface DataRpcDeps extends Omit<DataContext, "connection" | "by"> {
  /** Throws when the turn's capability is no longer live. */
  assertActive(): void;
}

export type DataToolsList = { tools: typeof DATA_TOOLS; instructions: string };

export async function dataRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: DataRpcDeps,
): Promise<DataToolsList | DataToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: DATA_TOOLS, instructions: DATA_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported data method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = dataToolCallProblem(params.name, args);
  if (problem) return dataErrorResult({ code: "invalid_input", message: problem });
  deps.assertActive();
  const { assertActive, ...context } = deps;
  const result = await runDataTool({ ...context, connection: "bot", by: "bot" }, params.name as string, args as Record<string, unknown>);
  assertActive();
  return result;
}
