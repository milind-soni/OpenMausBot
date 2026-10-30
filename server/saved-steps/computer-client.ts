import { computerPersonAwayText } from "../computer-wait.ts";
import { CONTROL_BUSY, CONTROL_HANDED_BACK, CONTROL_REFUSAL_PLAIN, CONTROL_UNCONFIRMED, CONTROL_WAITED } from "../control-client.ts";
import { ChatMcpClient } from "../drivers/chat-mcp-tools.ts";
import type { CallOutcome, ComputerCaller } from "./resolve.ts";

export const STEP_TIMEOUT_MS = 60_000;
const ERROR_CHARS = 300;
const INVALID: CallOutcome = { ok: false, error: "the computer returned an invalid result" };

export type LocalComputerSpec = { command: string; args: string[]; env: Record<string, string> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const GATE_REFUSALS: ReadonlySet<string> = new Set([CONTROL_REFUSAL_PLAIN, CONTROL_HANDED_BACK, CONTROL_WAITED, CONTROL_BUSY, CONTROL_UNCONFIRMED]);
const PERSON_AWAY = computerPersonAwayText(60_000).replace(/ for over [\s\S]*$/u, " for over ");
const gateRefusal = (text: string) => GATE_REFUSALS.has(text) || text.startsWith(PERSON_AWAY);

function errorOutcome(content: unknown[]): CallOutcome {
  const text = content.flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [])).join(" ").trim();
  if (!text) return { ok: false, error: "the tool reported an error" };
  return { ok: false, error: text.slice(0, ERROR_CHARS), ...(gateRefusal(text) ? { gate: true as const } : {}) };
}

function refusalText(refusal: unknown): string {
  if (isRecord(refusal)) {
    for (const key of ["message", "code"]) {
      const text = refusal[key];
      if (typeof text === "string" && text.trim()) return text.slice(0, ERROR_CHARS);
    }
  }
  return "the computer refused the call";
}

export function callOutcome(result: unknown): CallOutcome {
  if (!isRecord(result) || !Array.isArray(result.content)) return INVALID;
  const { isError, structuredContent } = result;
  if (isError !== undefined && typeof isError !== "boolean") return INVALID;
  if (structuredContent !== undefined && structuredContent !== null && !isRecord(structuredContent)) return INVALID;
  const structured = isRecord(structuredContent) ? structuredContent : {};
  if (isError) return errorOutcome(result.content);
  if (structured.refusal !== undefined && structured.refusal !== null) return { ok: false, error: refusalText(structured.refusal) };
  return { ok: true, structured };
}

function unjournalled(env: Record<string, string>): Record<string, string> {
  return { ...env, OMB_COMPUTER_JOURNAL: "0" };
}

export async function openComputerCaller(computer: LocalComputerSpec, signal: AbortSignal): Promise<ComputerCaller & { close(): Promise<void> }> {
  // Security invariant: a replay drives only the turn's gated proxy, so the control gate and the person's consent still apply.
  if (!computer.env.OMB_CONTROL_URL || !computer.env.OMB_CONTROL_TOKEN) throw new Error("this computer is not behind its control gate");
  const client = new ChatMcpClient({ command: computer.command, args: computer.args, env: unjournalled(computer.env) }, true);
  try {
    await client.tools(signal);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    async call(tool, args, callSignal) {
      try {
        return callOutcome(await client.call("tools/call", { name: tool, arguments: args }, callSignal, STEP_TIMEOUT_MS));
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "the computer could not be reached" };
      }
    },
    close: () => client.close(),
  };
}
