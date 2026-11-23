// Removes re-creatable dependency folders (node_modules, Python virtualenvs) from the task workspaces of long-idle
// threads. A conversation's own files, clones and outputs stay; only what an install puts back is removed, and never in
// a busy, unread or handed-off thread. Only folders folder sync never carries to the person's computer, so no copy of
// theirs changes. Removal is asynchronous: gigabytes of them must not stall the server's replies.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";

export const TASK_WORKSPACE_IDLE_DAYS = 14;
const MAX_DEPTH = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface TaskWorkspaceRetentionCandidate {
  botId: string;
  threadId: string;
  lastActiveAt: number;
  unread: boolean;
  busy: boolean;
  openDirectHandoff: boolean;
}

function isRecreatable(parent: string, name: string): boolean {
  if (name === "node_modules") return true;
  if (name === ".venv" || name === "venv") return existsSync(join(parent, name, "pyvenv.cfg"));
  return false;
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findRecreatable(dir: string, depth: number, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (!isRealDirectory(path)) continue;
    if (isRecreatable(dir, entry.name)) found.push(path);
    else if (depth < MAX_DEPTH) findRecreatable(path, depth + 1, found);
  }
}

/** Returns the folders it removed. Each candidate is read when its turn comes, so a thread that wakes mid-sweep is kept. */
export async function sweepTaskWorkspaceBuildFolders(
  candidates: Iterable<TaskWorkspaceRetentionCandidate>,
  idleDays: number = TASK_WORKSPACE_IDLE_DAYS,
  now: number = Date.now(),
  root: string = TASK_WORKSPACES_DIR,
): Promise<string[]> {
  const cutoff = now - idleDays * DAY_MS;
  const removed: string[] = [];
  for (const candidate of candidates) {
    if (candidate.unread || candidate.busy || candidate.openDirectHandoff) continue;
    if (candidate.lastActiveAt >= cutoff) continue;
    if (!ID.test(candidate.botId) || !ID.test(candidate.threadId)) continue;
    const botDir = join(root, candidate.botId);
    const workspace = join(botDir, candidate.threadId);
    if (!isRealDirectory(botDir) || !isRealDirectory(workspace)) continue;
    // One workspace's walk per turn of the event loop, even where nothing is removed.
    await new Promise((resolve) => setImmediate(resolve));
    const found: string[] = [];
    findRecreatable(workspace, 1, found);
    for (const path of found) {
      if (!isRealDirectory(path)) continue;
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 2 });
        removed.push(path);
      } catch (error) {
        console.warn(`[retention] could not remove ${path}: ${(error as Error).message}`);
      }
    }
  }
  return removed;
}
