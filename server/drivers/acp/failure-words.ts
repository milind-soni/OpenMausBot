import type { ServerText } from "../../../shared/server-text.ts";
import { runtimeErrorText } from "../runtime-notice-error.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { engineFailure, stopFailure } from "../engine-errors.ts";

export function acpStopFailure(result: { error?: unknown; message?: unknown; stopReason?: string | null }, provider: string) {
  const message = typeof result?.error === "string" && result.error ? result.error
    : typeof result?.message === "string" && result.message ? result.message : undefined;
  if (message) return engineFailure(provider, message) ?? { message };
  const failure = stopFailure(result?.stopReason, provider) ?? noticeFailure("chat.notice.acpNoReason", { provider });
  return engineFailure(provider, failure.message) ?? failure;
}

/** DeepSeek Harness (dsh) words for an MCP server that failed to connect while the session started. */
const MCP_START_FAILED = /\bmcp-client\(([^)]+)\): initial connection or tool synchronization failed\b/;

function mcpStartFailure(message: string, provider: string) {
  const server = MCP_START_FAILED.exec(message)?.[1];
  if (!server) return null;
  const what = server === "composio" ? "Connected apps" : `The "${server}" MCP server`;
  return { message: `${what} didn't connect, so ${provider} couldn't start this reply. Try again, or switch this bot to another AI.` };
}

export function acpRuntimeFailure(error: unknown, provider: string, account?: { message?: string; text?: ServerText }) {
  if (account?.message !== undefined) return { message: account.message, text: account.text };
  const message = error instanceof Error ? error.message : String(error);
  const mcp = mcpStartFailure(message, provider);
  if (mcp) return mcp;
  const failure = engineFailure(provider, message) ?? { message };
  const text = account?.text ?? runtimeErrorText(error) ?? failure.text;
  return text ? { ...failure, text } : failure;
}
