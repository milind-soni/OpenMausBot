// One board per window: the sidebar entry, the page and the conversation chip all read this copy, and every
// write replaces it whole, as the server sends it. The SSE frame and a refetch after a write land here too.
import { useSyncExternalStore } from "react";

import type { BoardState, BoardSnapshot } from "../../shared/board";
import type { LocaleKey } from "@/locales";
import { api, ApiError } from "@/state/api";

export type BoardStatus = "idle" | "loading" | "ready" | "error";

export interface BoardView {
  status: BoardStatus;
  board?: BoardSnapshot;
  error?: string;
  code?: BoardErrorCode;
  /** Bumped on every applied snapshot, so a list can re-render on a broadcast that changed nothing visible. */
  revision: number;
}

let view: BoardView = { status: "idle", revision: 0 };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: BoardView): void {
  view = next;
  for (const listener of listeners) listener();
}

export function boardView(): BoardView {
  return view;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBoard(): BoardView {
  return useSyncExternalStore(subscribe, boardView, boardView);
}

/** A write replaced the board: the server's copy is the truth, capabilities come with GET only. */
export function applyBoard(board: BoardState | BoardSnapshot): void {
  const capabilities = "capabilities" in board ? board.capabilities : view.board?.capabilities ?? { manage: false };
  publish({ status: "ready", board: { ...board, capabilities }, revision: view.revision + 1 });
}

export function applyBoardFrame(board: BoardState): void {
  applyBoard(board);
}

export function failBoard(code?: BoardErrorCode, message?: string): void {
  publish({ status: "error", code, error: message, revision: view.revision + 1 });
}

/** The newest snapshot, or a fresh read; concurrent callers share one request. */
export function loadBoard(options: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (!options.force && view.status === "ready") return Promise.resolve();
  publish({ status: view.board ? "ready" : "loading", board: view.board, revision: view.revision });
  inFlight = (async () => {
    try {
      const board = await api<BoardSnapshot>("/api/board");
      applyBoard(board);
    } catch (error) {
      failBoard(codeOf(error), error instanceof Error ? error.message : undefined);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Keeps a page that was left open current: refetch when it is shown again, without a poll. */
export function refreshBoardWhenShown(): () => void {
  const onShow = () => {
    if (document.visibilityState === "visible") void loadBoard({ force: true });
  };
  window.addEventListener("focus", onShow);
  document.addEventListener("visibilitychange", onShow);
  return () => {
    window.removeEventListener("focus", onShow);
    document.removeEventListener("visibilitychange", onShow);
  };
}

export type BoardErrorCode =
  | "BOARD_INVALID" | "BOARD_FORBIDDEN" | "BOARD_VERSION_CONFLICT" | "BOARD_NEEDS_EVIDENCE" | "BOARD_UNAVAILABLE";

export class BoardWriteError extends Error {
  readonly code: BoardErrorCode;
  constructor(code: BoardErrorCode, message: string) {
    super(message);
    this.name = "BoardWriteError";
    this.code = code;
  }
}

const ERROR_TEXT: Readonly<Record<BoardErrorCode, LocaleKey>> = {
  BOARD_INVALID: "board.error.invalid",
  BOARD_FORBIDDEN: "board.error.forbidden",
  BOARD_VERSION_CONFLICT: "board.error.conflict",
  BOARD_NEEDS_EVIDENCE: "board.error.needsEvidence",
  BOARD_UNAVAILABLE: "board.error.unavailable",
};

export function boardErrorText(error: unknown): LocaleKey {
  return error instanceof BoardWriteError ? ERROR_TEXT[error.code] : "board.error.unavailable";
}

export function boardErrorKey(code: BoardErrorCode | undefined): LocaleKey {
  return code ? ERROR_TEXT[code] : "board.error.unavailable";
}

function codeOf(error: unknown): BoardErrorCode {
  if (!(error instanceof ApiError)) return "BOARD_UNAVAILABLE";
  const code = error.body?.error;
  if (code === "BOARD_INVALID" || code === "BOARD_FORBIDDEN" || code === "BOARD_VERSION_CONFLICT" || code === "BOARD_NEEDS_EVIDENCE") return code;
  return error.status === 403 ? "BOARD_FORBIDDEN" : "BOARD_UNAVAILABLE";
}

/** One board write; the response's whole board replaces ours. `refresh` re-reads after a 409 so the next try is current. */
export async function writeBoard<T extends { board?: BoardState }>(path: string, init: RequestInit): Promise<T> {
  try {
    const answer = await api<T & { board: BoardState }>(path, init);
    if (answer.board) applyBoard(answer.board);
    return answer;
  } catch (error) {
    const code = codeOf(error);
    if (code === "BOARD_VERSION_CONFLICT") await loadBoard({ force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new BoardWriteError(code, message);
  }
}

export interface TaskWrite {
  botId: string;
  projectId?: string | null;
  subprojectId?: string | null;
  parentThreadId?: string | null;
  phase?: string;
  status?: string;
  owner?: string | null;
  acceptance?: string | null;
  blocked?: boolean;
  paused?: boolean;
}

export async function putTask(threadId: string, task: TaskWrite): Promise<void> {
  await writeBoard(`/api/board/tasks/${encodeURIComponent(threadId)}`, {
    method: "PUT",
    body: JSON.stringify({ ...task, version: view.board?.version }),
  });
}

export async function removeTask(threadId: string): Promise<void> {
  const version = view.board?.version;
  await writeBoard(`/api/board/tasks/${encodeURIComponent(threadId)}${version === undefined ? "" : `?version=${version}`}`, { method: "DELETE" });
}

export async function createProject(name: string, owner: string, goal: string, acceptance: string, description?: string): Promise<void> {
  await writeBoard("/api/board/projects", {
    method: "POST",
    body: JSON.stringify({
      name, owner: owner.trim(), goal: goal.trim(), acceptance: acceptance.trim(),
      ...(description?.trim() ? { description: description.trim() } : {}), version: view.board?.version,
    }),
  });
}

export async function createSubproject(projectId: string, name: string, owner: string, deliverable: string, acceptance: string): Promise<void> {
  await writeBoard("/api/board/subprojects", {
    method: "POST",
    body: JSON.stringify({
      projectId, name, owner: owner.trim(), deliverable: deliverable.trim(), acceptance: acceptance.trim(),
      version: view.board?.version,
    }),
  });
}

export async function createMilestone(input: { projectId: string; subprojectId?: string; title: string; dueAt?: number }): Promise<void> {
  await writeBoard("/api/board/milestones", {
    method: "POST",
    body: JSON.stringify({ ...input, version: view.board?.version }),
  });
}

export async function decideMilestone(id: string, decision: "accepted" | "rejected", verdict: string, evidence: string): Promise<void> {
  await writeBoard(`/api/board/milestones/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: decision, verdict, evidence, version: view.board?.version }),
  });
}

export async function startMilestone(id: string): Promise<void> {
  await writeBoard(`/api/board/milestones/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress", version: view.board?.version }),
  });
}

export async function decideTask(threadId: string, decision: "accepted" | "rejected", evidence: string): Promise<void> {
  await writeBoard(`/api/board/tasks/${encodeURIComponent(threadId)}/verdict`, {
    method: "POST",
    body: JSON.stringify({ decision, evidence, version: view.board?.version }),
  });
}

/** A new conversation that already belongs to a subproject, in the same request that creates it. */
export async function createConversationOnBoard(input: {
  botId: string; title?: string; projectId: string; subprojectId?: string; parentThreadId?: string; owner?: string;
}): Promise<{ bot: unknown; threadId: string }> {
  const answer = await api<{ bot: { threadId: string }; task: { threadId: string }; board?: BoardState }>(`/api/bots/${encodeURIComponent(input.botId)}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      board: {
        projectId: input.projectId,
        ...(input.subprojectId ? { subprojectId: input.subprojectId } : {}),
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
      },
    }),
  });
  if (answer.board) applyBoard(answer.board);
  return { bot: answer.bot, threadId: answer.task.threadId };
}
