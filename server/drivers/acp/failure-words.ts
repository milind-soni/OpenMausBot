import type { ServerText } from "../../../shared/server-text.ts";
import { runtimeErrorText } from "../runtime-notice-error.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { engineFailure, stopFailure } from "../engine-errors.ts";
import { eduMemoryNotice } from "../team-tools.ts";
import type { SendTurnInput } from "../../contracts.ts";

export function acpStopFailure(result: { error?: unknown; message?: unknown; stopReason?: string | null }, provider: string) {
  const message = typeof result?.error === "string" && result.error ? result.error
    : typeof result?.message === "string" && result.message ? result.message : undefined;
  if (message) return engineFailure(provider, message) ?? { message };
  const failure = stopFailure(result?.stopReason, provider) ?? noticeFailure("chat.notice.acpNoReason", { provider });
  return engineFailure(provider, failure.message) ?? failure;
}

/** DeepSeek Harness (dsh) words for an MCP server that failed to connect or sync its tools while the
 * session started. The whole error must be that failure (after an optional JSON-RPC message and before
 * an optional request context), so an earlier MCP failure quoted in other diagnostics keeps its text. */
const MCP_START_FAILED = /^(?:[^:\n]*: )?mcp-client\(([^)\n]+)\): initial connection or tool synchronization failed(?: \([^)\n]*\))?$/;

function mcpStartFailure(message: string, provider: string) {
  const server = MCP_START_FAILED.exec(message)?.[1];
  if (!server) return null;
  return server === "composio" ? noticeFailure("chat.notice.acpMcpAppsFailed", { provider }) : noticeFailure("chat.notice.acpMcpServerFailed", { server, provider });
}

/** The `edu` server, the bot's Edu brain, is optional: when dsh could not start it, the turn runs again without it after
 * the quiet Edu line (at most once an hour in the thread). False for any other failure or server. */
export function retryWithoutEdu(error: unknown, turn: SendTurnInput, run: {
  notice(notice: { message: string; text?: ServerText }): void;
  retry(next: SendTurnInput): () => Promise<unknown>;
  failed(error: unknown): void;
}): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!turn.integrations?.edu || MCP_START_FAILED.exec(message)?.[1] !== "edu") return false;
  const notice = eduMemoryNotice(turn.threadId);
  if (notice) run.notice(notice);
  const { edu: _edu, ...integrations } = turn.integrations;
  run.retry({ ...turn, integrations })().catch(run.failed);
  return true;
}

/** A failure the agent reported as an ordinary reply, already in the words the person reads. */
export class AcpReportedFailure extends Error {
  readonly facts: { message: string; text?: ServerText; limitResetsAt?: number };
  readonly acpUsageLimit: boolean;

  constructor(facts: { message: string; text?: ServerText; limitResetsAt?: number }, usageLimit: boolean) {
    super(facts.message);
    this.facts = facts;
    this.acpUsageLimit = usageLimit;
  }
}

export function acpRuntimeFailure(error: unknown, provider: string, account?: { message?: string; text?: ServerText }) {
  if (account?.message !== undefined) return { message: account.message, text: account.text };
  if (error instanceof AcpReportedFailure) return error.facts;
  const message = error instanceof Error ? error.message : String(error);
  // Account wording, when given, wins over the MCP rewrite.
  const mcp = account?.text ? null : mcpStartFailure(message, provider);
  if (mcp) return mcp;
  const failure = engineFailure(provider, message) ?? { message };
  const text = account?.text ?? runtimeErrorText(error) ?? failure.text;
  return text ? { ...failure, text } : failure;
}
