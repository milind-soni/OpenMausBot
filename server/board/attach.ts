// How a conversation joins the board: the same shape whether it arrives with a new task (POST
// /api/bots/:id/tasks `board`) or later (PUT /api/board/tasks/:threadId).
import type { BoardState, BoardTask } from "../../shared/board.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { actorFor, boardViewer, filterBoard, projectVisible } from "./access.ts";
import { BoardError, boardErrorStatus, type BoardStore } from "./store.ts";

export const BOARD_TASK_WRITE_FIELDS: ReadonlySet<string> = new Set([
  "botId", "projectId", "subprojectId", "parentThreadId", "phase", "phaseEvidence", "status", "owner", "ownerEmail", "acceptance",
  "blocked", "blockedReason", "paused", "pausedReason", "version",
]);

export type BoardAttachResult =
  | { ok: true; task: BoardTask; state: BoardState }
  | { ok: false; status: number; code: "BOARD_INVALID" | "BOARD_FORBIDDEN" | "BOARD_NEEDS_EVIDENCE" | "BOARD_VERSION_CONFLICT" | "BOARD_UNAVAILABLE" | "BOARD_BATCH_CONFLICT"; message: string };

export interface BoardAttachDeps {
  board: BoardStore;
  canManage(auth: RequestAuth): boolean;
  /** The caller's existing conversation/bot visibility; absence fails closed for a non-admin. */
  visibleFor?(auth: RequestAuth): VisibleSet;
}

/** `value` is the request's `board` object; `threadId` and `botId` come from the conversation itself, never from it. */
export function attachBoardTask(
  deps: BoardAttachDeps,
  auth: RequestAuth,
  input: { botId: string; threadId: string; value: unknown; knownThread: boolean },
): BoardAttachResult {
  if (!input.knownThread) return { ok: false, status: 400, code: "BOARD_INVALID", message: "no such conversation" };
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
    return { ok: false, status: 400, code: "BOARD_INVALID", message: "board must be a JSON object" };
  }
  const raw = input.value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!BOARD_TASK_WRITE_FIELDS.has(key)) return { ok: false, status: 400, code: "BOARD_INVALID", message: `unsupported board field: ${key}` };
  }
  const visible = deps.visibleFor?.(auth);
  const viewer = visible ? boardViewer(auth, visible) : null;
  const admin = deps.canManage(auth);
  if (!admin && !viewer) {
    return { ok: false, status: 403, code: "BOARD_FORBIDDEN", message: "Only an owner or admin may change the project board" };
  }
  const value: Record<string, unknown> = { ...raw };
  if (!admin) {
    if (typeof value.projectId === "string") {
      const project = deps.board.state().projects.find((candidate) => candidate.id === value.projectId);
      if (!project || !viewer || !projectVisible(project, viewer)) {
        return { ok: false, status: 403, code: "BOARD_FORBIDDEN", message: "You cannot see that project" };
      }
    }
    const actor = actorFor(auth);
    const ownerEmail = typeof value.ownerEmail === "string" ? value.ownerEmail.trim().toLowerCase() : undefined;
    if (ownerEmail && ownerEmail !== actor.email) {
      return { ok: false, status: 403, code: "BOARD_FORBIDDEN", message: "Only this project's owner can hand a task to someone else." };
    }
    if (actor.email) value.ownerEmail = actor.email;
    if (value.owner === undefined && actor.label) value.owner = actor.label;
  }
  try {
    const task = deps.board.putTask({ ...value, threadId: input.threadId, botId: input.botId }, actorFor(auth));
    const state = viewer && !admin ? filterBoard(deps.board.state(), viewer).state : deps.board.state();
    return { ok: true, task, state };
  } catch (error) {
    if (error instanceof BoardError) return { ok: false, status: boardErrorStatus[error.code], code: error.code, message: error.message };
    throw error;
  }
}

/** A coordinate_bots/start_thread dispatch: the new work conversation becomes a child of the source board task.
 * Board persistence is best-effort here; it must never turn a successful handoff into a failed one. */
export function attachDispatchedTask(
  deps: Pick<BoardAttachDeps, "board">,
  input: { parentThreadId: string; botId: string; threadId: string; actor: { label: string; email?: string } },
): BoardTask | null {
  try {
    return deps.board.attachDispatch(input);
  } catch (error) {
    console.warn(`board: could not attach dispatched conversation ${input.threadId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
