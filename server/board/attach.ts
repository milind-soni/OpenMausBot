// How a conversation joins the board: the same shape whether it arrives with a new task (POST
// /api/bots/:id/tasks `board`) or later (PUT /api/board/tasks/:threadId).
import type { BoardState, BoardTask } from "../../shared/board.ts";
import type { RequestAuth } from "../request-auth.ts";
import { BoardError, boardErrorStatus, type BoardStore } from "./store.ts";

export const BOARD_TASK_WRITE_FIELDS: ReadonlySet<string> = new Set([
  "botId", "projectId", "subprojectId", "parentThreadId", "phase", "status", "owner", "acceptance", "blocked", "paused", "version",
]);

export type BoardAttachResult =
  | { ok: true; task: BoardTask; state: BoardState }
  | { ok: false; status: number; code: "BOARD_INVALID" | "BOARD_FORBIDDEN" | "BOARD_NEEDS_EVIDENCE" | "BOARD_VERSION_CONFLICT"; message: string };

export interface BoardAttachDeps {
  board: BoardStore;
  canManage(auth: RequestAuth): boolean;
}

/** `value` is the request's `board` object; `threadId` and `botId` come from the conversation itself, never from it. */
export function attachBoardTask(
  deps: BoardAttachDeps,
  auth: RequestAuth,
  input: { botId: string; threadId: string; value: unknown; knownThread: boolean },
): BoardAttachResult {
  if (!deps.canManage(auth)) return { ok: false, status: 403, code: "BOARD_FORBIDDEN", message: "Only an owner or admin may change the project board" };
  if (!input.knownThread) return { ok: false, status: 400, code: "BOARD_INVALID", message: "no such conversation" };
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
    return { ok: false, status: 400, code: "BOARD_INVALID", message: "board must be a JSON object" };
  }
  for (const key of Object.keys(input.value)) {
    if (!BOARD_TASK_WRITE_FIELDS.has(key)) return { ok: false, status: 400, code: "BOARD_INVALID", message: `unsupported board field: ${key}` };
  }
  try {
    const task = deps.board.putTask({ ...(input.value as Record<string, unknown>), threadId: input.threadId, botId: input.botId });
    return { ok: true, task, state: deps.board.state() };
  } catch (error) {
    if (error instanceof BoardError) return { ok: false, status: boardErrorStatus[error.code], code: error.code, message: error.message };
    throw error;
  }
}
