// mausbot.app.call(name, input) from a saved app's page, on the same rpc route as mausbot.data and mausbot.state once the
// route has checked the bot, the conversation and the row. `engaged` is the bridge's own word that the person clicked in
// the app (the bridge runs in our renderer, not in the sealed page), which a `change` operation needs.
import { RPC_HOST_REFUSED, RPC_INVALID_PARAMS } from "../../shared/app-frame/bridge.ts";
import type { PageRpcAnswer } from "../routes/bot-page-rpc.ts";
import { AppOperationError } from "./errors.ts";
import type { AppOperations } from "./operations.ts";

export const APP_CALL_METHOD = "mausbot/app/call";

export interface AppCallDeps {
  operations: Pick<AppOperations, "run">;
  /** The saved app's folder shown in that message, or null when it shows no saved app. */
  appDirFor(threadId: string, messageId: string): string | null;
}

const STATUS: Record<string, number> = {
  invalid_input: 400, invalid_params: 400, too_large: 413, unknown_operation: 404, needs_click: 409, not_declared: 409,
  read_only: 409, busy: 429, timeout: 504, statement_timeout: 504, runtime_unavailable: 503, runtime_stopped: 503,
  database_stopped: 503, memory: 503, app_invalid: 422,
};

export async function appCallRpc(deps: AppCallDeps, call: { botId: string; threadId: string; messageId: string; params: Record<string, unknown>; engaged: boolean }): Promise<PageRpcAnswer> {
  const appDir = deps.appDirFor(call.threadId, call.messageId);
  if (!appDir) return { status: 409, body: { error: { code: RPC_HOST_REFUSED, message: "This page is not a saved app, so it has no operations." } } };
  const name = call.params.name;
  if (typeof name !== "string" || !name) return { status: 400, body: { error: { code: RPC_INVALID_PARAMS, message: "mausbot.app.call needs (name, input?)." } } };
  try {
    const result = await deps.operations.run({ appDir, name, input: call.params.input, caller: { botId: call.botId, via: "page", engaged: call.engaged } });
    return { status: 200, body: { result } };
  } catch (error) {
    if (!(error instanceof AppOperationError)) throw error;
    const status = STATUS[error.code] ?? 422;
    return { status, body: { error: { code: status === 400 ? RPC_INVALID_PARAMS : RPC_HOST_REFUSED, message: error.message, reason: error.code } } };
  }
}
