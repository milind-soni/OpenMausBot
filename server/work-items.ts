// A durable board of work, alongside the bots that do it.
//
// The delegation queue (delegations.ts) already tracks work that moves BETWEEN
// bots, but it is deliberately invisible: an item exists only as queued or
// drained, with no owner, no status, and no place on a screen. The team map
// shows who talks to whom, not who owes what. This module is the missing
// record — one row per piece of work, owned by one bot, carrying a status a
// person set and a link to the thread the work actually happens in.
//
// It is a PARALLEL record, never a replacement. A work item does not queue,
// drain, or dispatch anything: starting and stopping the bot stays on the
// routes that already own those paths (`POST /api/bots/:id/messages` and
// `/interrupt`). That keeps one implementation of "run a turn" in the app
// instead of two that can disagree.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

/** The columns a board shows, left to right. `backlog` and `todo` are the two
 * kinds of not-started; `done` and `cancelled` are terminal. */
export type WorkStatus = "backlog" | "todo" | "in_progress" | "blocked" | "done" | "cancelled";

/** Until a thread exists, a card can only be looked at. */
export interface WorkArtifact {
  kind: "file" | "url" | "thread";
  ref: string;
  label?: string;
}

export interface WorkItem {
  id: string;
  boardId: string;
  title: string;
  brief: string;
  status: WorkStatus;
  /** Position within its column. Sparse on purpose: a drag writes one number
   * between its neighbours rather than renumbering the column. */
  order: number;
  /** The bot the work is assigned to. Absent on a card nobody owns yet. */
  ownerBotId?: string;
  /** The bot's thread this work runs in — created on the first start and then
   * kept for the life of the item, so "open the chat" always lands on the
   * history of THIS work rather than a fresh empty thread. */
  threadId?: string;
  artifacts: WorkArtifact[];
  /** Approval posture for the card's own turn, mirroring TaskRecord. */
  approvalMode?: string;
  createdAt: number;
  updatedAt: number;
  /** When the last start was dispatched, so a card can show elapsed time. */
  startedAt?: number;
  /** Why the last start failed. Kept on the item so a failure is visible on
   * the board and not only in a transcript nobody is looking at. */
  lastError?: string;
}

export const WORK_STATUSES: readonly WorkStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

/** A terminal status is terminal: a card that is done and then silently goes
 * back to running stops being a record of what happened. The UI makes a
 * person reopen it deliberately instead. */
const TERMINAL: ReadonlySet<WorkStatus> = new Set(["done", "cancelled"]);

export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && (WORK_STATUSES as readonly string[]).includes(value);
}

/** The default board. Cards created before boards were a concept, and every
 * card a client creates without naming one, belong here. */
export const DEFAULT_BOARD_ID = "default";

interface WorkItemsFile {
  version: 1;
  items: WorkItem[];
}

export interface WorkItemInput {
  title: string;
  brief?: string;
  status?: WorkStatus;
  boardId?: string;
  ownerBotId?: string | null;
  approvalMode?: string | null;
}

export interface WorkItemPatch {
  title?: string;
  brief?: string;
  status?: WorkStatus;
  order?: number;
  ownerBotId?: string | null;
  approvalMode?: string | null;
  artifacts?: WorkArtifact[];
}

const MAX_TITLE = 200;
const MAX_BRIEF = 20_000;
const MAX_ARTIFACTS = 50;
/** A board nobody prunes is a JSON file that grows without bound, and the
 * whole file is rewritten on every mutation. Far past what a board screen can
 * usefully show, so the cap costs nothing a person would miss. */
export const MAX_WORK_ITEMS = 1_000;

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

/** A brief and an artifact label are authored by whoever wrote the card —
 * often a bot quoting a command line or a log. Scrub them the same way a
 * bot's chat text is scrubbed, for the same reason: stored is permanent. */
function scrub(value: string): string {
  return redactSecretsInText(value);
}

function cleanArtifacts(value: unknown): WorkArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: WorkArtifact[] = [];
  for (const raw of value.slice(0, MAX_ARTIFACTS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<WorkArtifact>;
    if (item.kind !== "file" && item.kind !== "url" && item.kind !== "thread") continue;
    const ref = cleanText(item.ref, 2_000);
    if (!ref) continue;
    const label = cleanText(item.label, 300);
    out.push({ kind: item.kind, ref, ...(label ? { label: scrub(label) } : {}) });
  }
  return out;
}

function cleanOrder(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cleanBotId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id || undefined;
}

/**
 * One board's worth of work, persisted as a single JSON file.
 *
 * The file is injectable so tests get a disposable path without stubbing HOME
 * and re-importing the module graph (the shape `RoutineManager` already uses).
 */
export class WorkItems {
  private readonly file: string;
  private readonly now: () => number;
  private items: WorkItem[] = [];

  constructor(options: { file?: string; now?: () => number } = {}) {
    this.file = options.file ?? join(DATA_DIR, "work-items.json");
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  /**
   * Missing or corrupt → empty. The board is a convenience view over work that
   * also exists in transcripts; refusing to boot because its index is
   * unreadable would cost far more than it saves.
   */
  private load(): void {
    this.items = [];
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WorkItemsFile>;
      if (!Array.isArray(disk.items)) return;
      this.items = disk.items.flatMap((value): WorkItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<WorkItem>;
        if (typeof item.id !== "string" || !item.id) return [];
        if (typeof item.title !== "string" || !item.title.trim()) return [];
        if (!isWorkStatus(item.status)) return [];
        const createdAt = typeof item.createdAt === "number" ? item.createdAt : this.now();
        const owner = cleanBotId(item.ownerBotId);
        const threadId = cleanBotId(item.threadId);
        return [{
          id: item.id,
          boardId: cleanText(item.boardId, 64) || DEFAULT_BOARD_ID,
          title: item.title.slice(0, MAX_TITLE),
          brief: scrub(typeof item.brief === "string" ? item.brief.slice(0, MAX_BRIEF) : ""),
          status: item.status,
          order: cleanOrder(item.order),
          ...(owner ? { ownerBotId: owner } : {}),
          ...(threadId ? { threadId } : {}),
          artifacts: cleanArtifacts(item.artifacts),
          ...(typeof item.approvalMode === "string" && item.approvalMode ? { approvalMode: item.approvalMode } : {}),
          createdAt,
          updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : createdAt,
          ...(typeof item.startedAt === "number" ? { startedAt: item.startedAt } : {}),
          ...(typeof item.lastError === "string" && item.lastError ? { lastError: scrub(item.lastError.slice(0, 2_000)) } : {}),
        }];
      });
    } catch {
      /* fresh install, or unreadable — start empty */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const payload: WorkItemsFile = { version: 1, items: this.items };
      writeFileAtomic(this.file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("work-items: could not persist board", error);
    }
  }

  list(filter: { boardId?: string; ownerBotId?: string; status?: WorkStatus[] } = {}): WorkItem[] {
    const wanted = filter.status ? new Set(filter.status) : null;
    return this.items.filter((item) => {
      if (filter.boardId !== undefined && item.boardId !== filter.boardId) return false;
      if (filter.ownerBotId !== undefined && item.ownerBotId !== filter.ownerBotId) return false;
      if (wanted && !wanted.has(item.status)) return false;
      return true;
    });
  }

  get(id: string): WorkItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** The card a bot's thread belongs to, if any — what makes a chat opened
   * from the sidebar findable on the board, and vice versa. */
  byThread(threadId: string): WorkItem | undefined {
    return this.items.find((item) => item.threadId === threadId);
  }

  create(input: WorkItemInput): WorkItem {
    this.prune();
    const title = cleanText(input.title, MAX_TITLE);
    if (!title) throw Object.assign(new Error("a card needs a title"), { status: 400 });
    const brief = cleanText(input.brief, MAX_BRIEF);
    const status = input.status && isWorkStatus(input.status) ? input.status : "backlog";
    const boardId = cleanText(input.boardId, 64) || DEFAULT_BOARD_ID;
    const owner = cleanBotId(input.ownerBotId);
    const at = this.now();
    const item: WorkItem = {
      id: newId(),
      boardId,
      title,
      brief: brief ? scrub(brief) : "",
      status,
      // New cards land at the top of their column.
      order: this.nextOrder(boardId, status),
      ...(owner ? { ownerBotId: owner } : {}),
      artifacts: [],
      ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.items.push(item);
    this.save();
    return item;
  }

  update(id: string, patch: WorkItemPatch): WorkItem {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("no such card"), { status: 404 });
    if (patch.status !== undefined && !isWorkStatus(patch.status)) {
      throw Object.assign(new Error("unknown status"), { status: 400 });
    }
    // Reopening is a deliberate move out of a terminal column, so a plain
    // status patch is allowed to do it — but it clears the finished marks.
    const next: WorkItem = { ...item, updatedAt: this.now() };
    if (patch.title !== undefined) {
      const title = cleanText(patch.title, MAX_TITLE);
      if (!title) throw Object.assign(new Error("a card needs a title"), { status: 400 });
      next.title = title;
    }
    if (patch.brief !== undefined) {
      const brief = cleanText(patch.brief, MAX_BRIEF);
      next.brief = brief ? scrub(brief) : "";
    }
    if (patch.status !== undefined) {
      next.status = patch.status;
      if (TERMINAL.has(patch.status)) next.startedAt = undefined;
      else if (patch.status === "in_progress") next.startedAt = next.startedAt ?? this.now();
    }
    if (patch.order !== undefined) next.order = cleanOrder(patch.order);
    if (patch.approvalMode !== undefined) {
      next.approvalMode = patch.approvalMode ? patch.approvalMode : undefined;
    }
    if (patch.ownerBotId !== undefined) {
      const owner = cleanBotId(patch.ownerBotId);
      // Reassigning to a different bot abandons the old bot's thread: keeping
      // it would point "open the chat" at a conversation the new owner has
      // never seen.
      if (owner !== item.ownerBotId) {
        next.ownerBotId = owner;
        next.threadId = undefined;
        next.startedAt = undefined;
      }
    }
    if (patch.artifacts !== undefined) next.artifacts = cleanArtifacts(patch.artifacts);
    this.items = this.items.map((candidate) => (candidate.id === id ? next : candidate));
    this.save();
    return next;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Record the thread a card's work runs in, and mark it started.
   *
   * Called from the run route — but the route does the starting. This only
   * remembers what happened, so a failure here can never leave a bot running
   * with no record, and a failure there leaves a card that is simply not
   * marked as started.
   */
  attachThread(id: string, threadId: string): WorkItem {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("no such card"), { status: 404 });
    const at = this.now();
    const next: WorkItem = {
      ...item,
      threadId,
      startedAt: at,
      updatedAt: at,
      lastError: undefined,
      // Restarting a blocked card clears the block: it is running again, so
      // leaving it in the blocked column would contradict what just happened.
      status: TERMINAL.has(item.status) ? item.status : "in_progress",
    };
    this.items = this.items.map((candidate) => (candidate.id === id ? next : candidate));
    this.save();
    return next;
  }

  fail(id: string, reason: string): WorkItem {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("no such card"), { status: 404 });
    const next: WorkItem = {
      ...item,
      status: "blocked",
      lastError: scrub(reason).slice(0, 2_000),
      updatedAt: this.now(),
    };
    this.items = this.items.map((candidate) => (candidate.id === id ? next : candidate));
    this.save();
    return next;
  }

  /** Position a new card at the top of its column: one below the current
   * minimum, which keeps the sparse-order trick working at the front too. */
  private nextOrder(boardId: string, status: WorkStatus): number {
    const column = this.items.filter((item) => item.boardId === boardId && item.status === status);
    if (!column.length) return 0;
    return Math.min(...column.map((item) => item.order)) - 1;
  }

  /** Drop the oldest finished cards once the board is over its cap. Finished
   * only: a person's open work is never discarded to make room. */
  private prune(): void {
    if (this.items.length < MAX_WORK_ITEMS) return;
    const finished = this.items
      .filter((item) => TERMINAL.has(item.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const excess = this.items.length - MAX_WORK_ITEMS + 1;
    if (excess <= 0 || finished.length === 0) return;
    const drop = new Set(finished.slice(0, excess).map((item) => item.id));
    this.items = this.items.filter((item) => !drop.has(item.id));
  }
}

/** Test-only: forget every card, so a suite does not inherit the previous one. */
export function _resetWorkItems(manager: WorkItems): void {
  for (const item of manager.list()) manager.remove(item.id);
}