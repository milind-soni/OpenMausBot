// The board screen's pure helpers (Phase 3 part 2): what the columns are,
// how cards group and sort, what a card's spend reads, and which cards need
// a person. Nothing here touches the network or React.

export type BoardStatus = "todo" | "ready" | "running" | "blocked" | "review" | "done" | "archived";

export interface GateResultView { name: string; status: "pass" | "fail" | "timeout"; seconds: number; tail: string }

/** One task as GET /api/tasks returns it (server/task-board.ts BoardTask + hold). */
export interface BoardTaskView {
  id: string;
  title: string;
  body: string;
  status: BoardStatus;
  assigneeBotId: string | null;
  createdByBotId: string | null;
  priority: number;
  threadId: string | null;
  result: string | null;
  blockedReason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  owner: string | null;
  dueAt: number | null;
  budgetUsd: number | null;
  spentUsd: number;
  unpricedTurns: number;
  gates: { results: GateResultView[]; scope: string } | null;
  gatesAt: number | null;
  /** Why an assigned task will not run as things stand (server dispatch.hold). */
  hold: string | null;
}

export const BOARD_COLUMNS = ["todo", "ready", "running", "blocked", "review", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** The reason the server gives a task paused for money; a raised cap resumes it. */
export const BUDGET_PAUSED_REASON = "paused, needs a budget increase";

export function groupByStatus(tasks: readonly BoardTaskView[]): Record<BoardColumn, BoardTaskView[]> {
  const grouped = Object.fromEntries(BOARD_COLUMNS.map((column) => [column, [] as BoardTaskView[]])) as Record<BoardColumn, BoardTaskView[]>;
  for (const task of tasks) {
    if (task.status === "archived") continue;
    grouped[task.status].push(task);
  }
  for (const column of BOARD_COLUMNS) grouped[column].sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
  return grouped;
}

/** The pause card's rule: allow the cap again, never under a dollar. */
export function raiseStep(budgetUsd: number | null): number {
  return Math.max(1, typeof budgetUsd === "number" && Number.isFinite(budgetUsd) ? budgetUsd : 0);
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export function spendLabel(task: Pick<BoardTaskView, "spentUsd" | "budgetUsd">): string {
  if (typeof task.budgetUsd === "number") return `${usd(task.spentUsd)} of ${usd(task.budgetUsd)}`;
  if (task.spentUsd > 0) return usd(task.spentUsd);
  return "";
}

export type CardTone = "none" | "accent" | "warning" | "danger";

/** What needs a person, at a glance: paused or blocked, or a failed gate, is
 * danger; an assigned task that will not run is warning; review is accent. */
export function cardTone(task: Pick<BoardTaskView, "status" | "hold" | "gates" | "blockedReason">): CardTone {
  if (task.status === "blocked") return "danger";
  if (task.gates?.results.some((r) => r.status !== "pass")) return "danger";
  if (task.hold) return "warning";
  if (task.status === "review") return "accent";
  return "none";
}

/** Where a person may drag a card: the board's legal moves a person makes
 * by hand. The dispatcher owns running, the cap owns blocked, archive is a
 * button, and a ready task has nowhere to go but into the dispatcher. */
export function dropTargets(from: BoardStatus): BoardColumn[] {
  switch (from) {
    case "todo": return ["ready"];
    case "blocked": return ["ready"];
    case "review": return ["done", "ready"];
    default: return [];
  }
}
