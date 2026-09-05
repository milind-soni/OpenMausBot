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

export type WorkerTaskOp = "propose" | "status" | "run" | "results" | "describe" | "computer";

export type WorkerTaskContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Shared wire limits. The service imports these so it never emits a reply
 * that this client will reject after the worker action already happened. */
export const WORKER_TASK_MAX_REPLY_TEXT_CHARS = 1024 * 1024;
export const WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS = 16;
export const WORKER_TASK_MAX_REPLY_IMAGE_CHARS = 22 * 1024 * 1024;

const contentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(WORKER_TASK_MAX_REPLY_TEXT_CHARS) }),
  z.object({
    type: z.literal("image"),
    data: z.string().max(WORKER_TASK_MAX_REPLY_IMAGE_CHARS),
    mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
  }),
]);

/** The harness answers with one of these two fields and nothing else. */
const replySchema = z.object({
  text: z.string().max(WORKER_TASK_MAX_REPLY_TEXT_CHARS).optional(),
  content: z.array(contentSchema).max(WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS).optional(),
  isError: z.boolean().optional(),
  error: z.string().max(4096).optional(),
}).loose();

export interface WorkerTaskReply {
  /** Rendered for the model as the tool result body. */
  text: string;
  content?: WorkerTaskContent[];
  isError: boolean;
}

export interface WorkerTaskClient {
  call(op: WorkerTaskOp, payload: JsonObject): Promise<WorkerTaskReply>;
  readonly configured: boolean;
}

/** Long enough for the whole approval to resolve: proposing a task shows a card
 * and waits for a person, which is minutes, not seconds. */
const CALL_TIMEOUT_MS = 16 * 60_000;

const UNAVAILABLE_TEXT =
  "OpenMausBot could not be reached, so this worker task was NOT performed and nothing was approved. " +
  "Do not retry in a loop — tell the person the control plane is unavailable.";
const UNAVAILABLE: WorkerTaskReply = {
  text: UNAVAILABLE_TEXT,
  content: [{ type: "text", text: UNAVAILABLE_TEXT }],
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
          body: JSON.stringify({ ...payload, op }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const body = replySchema.safeParse(await res.json().catch(() => null));
        if (!res.ok) {
          const reason = body.success && body.data.error ? body.data.error : `request failed (${res.status})`;
          const text = `This worker task was NOT performed: ${reason}`;
          return { text, content: [{ type: "text", text }], isError: true };
        }
        if (body.success && (body.data.text !== undefined || body.data.content !== undefined)) {
          const content = body.data.content ?? [{ type: "text" as const, text: body.data.text ?? "" }];
          const text = body.data.text ?? content.find((block) => block.type === "text")?.text ?? "";
          return { text, content, isError: body.data.isError === true };
        }
        const text = "This worker task returned an unreadable result and was NOT performed.";
        return { text, content: [{ type: "text", text }], isError: true };
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
