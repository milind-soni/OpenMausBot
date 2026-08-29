// The proxy-side half of the worker task layer, mirroring control-client.ts.
//
// The MCP bridge runs as a separate per-turn process and has no view of the
// worker registry, the approval card, or the SSH transport — all three live in
// the harness. So the task tools it exposes are RPCs to the harness's loopback
// endpoint, and this file is the whole of that conversation.
//
// Failure posture: CLOSED, and the opposite of control-client.ts on purpose.
// Control is cooperation about who is holding the mouse; a task is authority to
// execute on a real machine. An unreachable harness cannot have approved
// anything, so it must read as a refusal, never as a pass.

import { z } from "zod";

import type { JsonObject } from "./schema.ts";

export type WorkerTaskOp = "propose" | "status" | "run" | "results";

/** The harness answers with one of these two fields and nothing else. */
const replySchema = z.object({
  text: z.string().max(1024 * 1024).optional(),
  error: z.string().max(4096).optional(),
}).loose();

export interface WorkerTaskReply {
  /** Rendered for the model as the tool result body. */
  text: string;
  isError: boolean;
}

export interface WorkerTaskClient {
  call(op: WorkerTaskOp, payload: JsonObject): Promise<WorkerTaskReply>;
  readonly configured: boolean;
}

/** Long enough for the whole approval to resolve: proposing a task shows a card
 * and waits for a person, which is minutes, not seconds. */
const CALL_TIMEOUT_MS = 16 * 60_000;

const UNAVAILABLE: WorkerTaskReply = {
  text:
    "OpenMausBot could not be reached, so this worker task was NOT performed and nothing was approved. " +
    "Do not retry in a loop — tell the person the control plane is unavailable.",
  isError: true,
};

export function createWorkerTaskClient(options?: {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): WorkerTaskClient {
  const url = options?.url ?? process.env.OMB_TASK_URL ?? "";
  const token = options?.token ?? process.env.OMB_TASK_TOKEN ?? "";
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  return {
    configured,
    async call(op: WorkerTaskOp, payload: JsonObject): Promise<WorkerTaskReply> {
      if (!configured) return UNAVAILABLE;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ op, ...payload }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const body = replySchema.safeParse(await res.json().catch(() => null));
        if (!res.ok) {
          const reason = body.success && body.data.error ? body.data.error : `request failed (${res.status})`;
          return { text: `This worker task was NOT performed: ${reason}`, isError: true };
        }
        if (body.success && body.data.text !== undefined) return { text: body.data.text, isError: false };
        return { text: "This worker task returned an unreadable result and was NOT performed.", isError: true };
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
