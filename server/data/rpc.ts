// The turn's capability must still be live before and after anything touches the database.
import { DATA_INSTRUCTIONS } from "./instructions.ts";
import type { DataCard } from "../../shared/data-surface.ts";
import { DATA_TOOLS, dataErrorResult, dataToolCallProblem, runDataTool, type DataContext, type DataToolResult } from "./tools.ts";

export const DATA_INTERNAL_MCP_PATH = "/api/internal/data/mcp";

export interface DataRpcDeps extends Omit<DataContext, "connection" | "by"> {
  assertActive(): void;
  onShow?(card: DataCard): void;
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
  let shown: DataCard | undefined;
  const result = await runDataTool({ ...context, connection: "bot", by: "bot" }, params.name as string, args as Record<string, unknown>, (card) => { shown = card; });
  assertActive();
  if (!result.isError && shown) {
    const current = deps.sheet.card(shown.id);
    // Cleanup may yield while another edit replaces this result: never receipt that edit as ours.
    if (current?.status === "ready" && current.result === shown.result) deps.onShow?.(shown);
  }
  return result;
}
