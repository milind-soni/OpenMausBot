import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { touchProject } from "./lib/permissions";
import { cleanLabels, projectLabels, registerLabels, workspaceLabelRows } from "./lib/labels";
import { githubSyncEnabled, markPending, mirrorRow, mirrorsAsPullRequest, taskInDraft } from "./lib/githubIssueSync";
import {
  bodyHash, githubBody, labelsHash, originDescription, originLabels, originTitle, titleHash, type IssuePatch,
} from "../lib/github-issue-sync";

/*
 * Two-way GitHub issue sync. Every Origin issue outside Backlog (the draft column) is a GitHub issue in the project's
 * repository; title, description (body), labels and open/closed state follow whichever side changed last.
 *
 * - Outbound: issue writes queue the issue (convex/lib/githubIssueSync.ts). The Next worker (lib/github-sync.ts,
 *   run by the integration tick and woken by integrations.kick) creates the GitHub issue when there is none, or reads
 *   it, calls `reconcile` with what GitHub has, and PATCHes the fields `reconcile` says Origin changed, then reports
 *   GitHub's answer to `pushed`.
 * - Inbound: GitHub's `issues` webhook (and the periodic reconcile page) read the issue and call `reconcile` too.
 * - Loops: per field, `githubIssueMirrors` keeps a fingerprint of the content both sides last agreed on. Only a side
 *   that differs from it changed; our own write comes back from GitHub identical to the fingerprint and is ignored.
 * - Delete: deleting an Origin issue closes its GitHub issue as "not planned". GitHub's REST API cannot delete issues;
 *   the worker deletes instead only when ORIGIN_GITHUB_DELETE_ISSUES=true and its token may (GraphQL deleteIssue,
 *   repository admin), falling back to closing.
 */

const LEASE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

const remoteValidator = v.object({
  number: v.number(), state: v.union(v.literal("open"), v.literal("closed")), updatedAt: v.number(),
  title: v.optional(v.string()), body: v.optional(v.string()), labels: v.optional(v.array(v.string())),
});
type Remote = typeof remoteValidator.type;
const patchValidator = v.object({
  title: v.optional(v.string()), body: v.optional(v.string()), labels: v.optional(v.array(v.string())),
  state: v.optional(v.union(v.literal("open"), v.literal("closed"))),
  state_reason: v.optional(v.union(v.literal("completed"), v.literal("not_planned"), v.literal("reopened"))),
});
const planValidator = v.object({
  action: v.union(v.literal("none"), v.literal("create"), v.literal("sync"), v.literal("push")),
  number: v.optional(v.number()),
  patch: v.optional(patchValidator),
});
type Plan = typeof planValidator.type;

type Decision = "same" | "pull" | "push";
/** Three-way merge of one field: the agreed fingerprint, Origin's and GitHub's (undefined when GitHub did not say). */
function decide(base: string | undefined, local: string, remote: string | undefined, firstContact: Decision, remoteNewer: boolean, stale: boolean): Decision {
  if (remote === undefined || stale) return base !== undefined && local !== base ? "push" : "same";
  if (local === remote) return "same";
  if (base === undefined) return firstContact;
  const remoteChanged = remote !== base, localChanged = local !== base;
  if (remoteChanged && localChanged) return remoteNewer ? "pull" : "push";
  return remoteChanged ? "pull" : localChanged ? "push" : "same";
}

async function canonicalLabels(ctx: MutationCtx, task: Doc<"tasks">, names: string[]) {
  const known = [...await projectLabels(ctx, task.projectId), ...task.teamId ? (await workspaceLabelRows(ctx, task.teamId)).map(row => row.name) : []];
  return cleanLabels(originLabels(names), known);
}

async function ensureMirror(ctx: MutationCtx, task: Doc<"tasks">) {
  const row = await mirrorRow(ctx, task._id);
  if (row) return row;
  const now = Date.now();
  const id = await ctx.db.insert("githubIssueMirrors", { projectId: task.projectId, taskId: task._id, pending: false, revision: 0, attempts: 0, nextAt: now, updatedAt: now });
  return (await ctx.db.get(id))!;
}

/**
 * The sync plan for one issue. Without `remote`: whether the worker needs to create the GitHub issue ("create"),
 * read it because Origin changed ("sync"), or nothing. With `remote` (what GitHub has now): applies GitHub's changes
 * to the Origin issue and returns the fields to PATCH on GitHub ("push"), if any.
 */
export const reconcile = internalMutation({
  args: { taskId: v.id("tasks"), remote: v.optional(remoteValidator) },
  returns: planValidator,
  handler: async (ctx, a): Promise<Plan> => {
    const task = await ctx.db.get(a.taskId);
    const project = task ? await ctx.db.get(task.projectId) : null;
    if (!task || !project || !await githubSyncEnabled(ctx, project) || mirrorsAsPullRequest(task, project)) return { action: "none" };
    const draft = await taskInDraft(ctx, task);
    const number = task.githubIssueNumber;
    if (!number) return { action: draft ? "none" : "create" };
    const mirror = await ensureMirror(ctx, task);
    const local = { title: titleHash(task.title), body: bodyHash(task.description), labels: labelsHash(task.labels) };
    const wantClosed = task.done || draft;
    const remote: Remote | undefined = a.remote;
    if (!remote) {
      const changed = local.title !== mirror.titleHash || local.body !== mirror.bodyHash || local.labels !== mirror.labelsHash
        || (wantClosed && task.githubIssueState !== "closed") || (!wantClosed && task.githubIssueReopenRequested === true && task.githubIssueState === "closed");
      return { action: changed ? "sync" : "none", number };
    }
    if (remote.number !== number) throw new ConvexError("GitHub issue does not match this Origin issue");
    const stale = remote.updatedAt < (task.githubIssueUpdatedAt ?? 0);
    const remoteNewer = remote.updatedAt > task.updatedAt;
    const apply: Partial<Pick<Doc<"tasks">, "title" | "description" | "labels">> = {};
    const agreed: Partial<Pick<Doc<"githubIssueMirrors">, "titleHash" | "bodyHash" | "labelsHash">> = {};
    const patch: IssuePatch = {};

    const remoteTitle = remote.title === undefined ? undefined : originTitle(remote.title);
    // First contact (no fingerprint yet, e.g. issues linked before this sync existed): Origin's title wins.
    const title = decide(mirror.titleHash, local.title, remoteTitle === undefined ? undefined : titleHash(remoteTitle), "push", remoteNewer, stale);
    if (title === "pull" && remoteTitle) { apply.title = remoteTitle; agreed.titleHash = titleHash(remoteTitle); }
    else if (title === "push") patch.title = task.title;
    else if (remoteTitle !== undefined && !stale) agreed.titleHash = local.title;

    const remoteBody = remote.body === undefined ? undefined : originDescription(remote.body);
    // First contact: Origin's description wins unless it has none.
    const body = decide(mirror.bodyHash, local.body, remoteBody === undefined ? undefined : bodyHash(remoteBody), originDescription(task.description) ? "push" : "pull", remoteNewer, stale);
    if (body === "pull" && remoteBody !== undefined) { apply.description = remoteBody || undefined; agreed.bodyHash = bodyHash(remoteBody); }
    else if (body === "push") patch.body = githubBody(task._id, task.description);
    else if (remoteBody !== undefined && !stale) agreed.bodyHash = local.body;

    if (remote.labels !== undefined && !stale && mirror.labelsHash === undefined && labelsHash(remote.labels) !== local.labels) {
      // First contact: keep both sides' labels.
      const union = await canonicalLabels(ctx, task, [...task.labels ?? [], ...remote.labels]);
      if (labelsHash(union) !== local.labels) apply.labels = union;
      if (labelsHash(union) !== labelsHash(remote.labels)) patch.labels = union;
      else agreed.labelsHash = labelsHash(union);
    } else {
      const labels = decide(mirror.labelsHash, local.labels, remote.labels === undefined ? undefined : labelsHash(remote.labels), "push", remoteNewer, stale);
      if (labels === "pull" && remote.labels) { apply.labels = await canonicalLabels(ctx, task, remote.labels); agreed.labelsHash = labelsHash(remote.labels); }
      else if (labels === "push") patch.labels = task.labels ?? [];
      else if (remote.labels !== undefined && !stale) agreed.labelsHash = local.labels;
    }

    if (remote.state === "open" && wantClosed) Object.assign(patch, { state: "closed", state_reason: task.done ? "completed" : "not_planned" });
    else if (remote.state === "closed" && !wantClosed && task.githubIssueReopenRequested) Object.assign(patch, { state: "open", state_reason: "reopened" });

    if (Object.keys(apply).length) {
      await ctx.db.patch(task._id, { ...apply, ...(apply.labels && !apply.labels.length ? { labels: undefined } : {}), updatedAt: Date.now() });
      if (apply.labels?.length && task.teamId) await registerLabels(ctx, task.teamId, apply.labels);
      await touchProject(ctx, task.projectId);
    }
    if (Object.keys(agreed).length) await ctx.db.patch(mirror._id, { ...agreed, updatedAt: Date.now() });
    return Object.keys(patch).length ? { action: "push", number, patch } : { action: "none", number };
  },
});

/** Records what GitHub answered to the worker's create or PATCH: the content both sides now agree on, and the state. */
export const pushed = internalMutation({
  args: { taskId: v.id("tasks"), remote: remoteValidator },
  returns: v.null(),
  handler: async (ctx, a) => {
    const task = await ctx.db.get(a.taskId);
    if (!task || task.githubIssueNumber !== a.remote.number) return null;
    const mirror = await ensureMirror(ctx, task);
    const { title, body, labels } = a.remote;
    await ctx.db.patch(mirror._id, {
      ...(title !== undefined ? { titleHash: titleHash(title) } : {}),
      ...(body !== undefined ? { bodyHash: bodyHash(body) } : {}),
      ...(labels !== undefined ? { labelsHash: labelsHash(labels) } : {}),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(task._id, {
      githubIssueState: a.remote.state, githubIssueUpdatedAt: Math.max(task.githubIssueUpdatedAt ?? 0, a.remote.updatedAt), githubIssueSyncedAt: Date.now(),
      githubSyncState: "synced", githubSyncError: undefined,
      ...(a.remote.state === "open" ? { githubIssueReopenRequested: undefined } : {}),
    });
    return null;
  },
});

const claimed = v.object({
  taskId: v.id("tasks"), projectId: v.id("projects"), revision: v.number(),
  deleted: v.optional(v.object({ repoUrl: v.string(), number: v.number() })),
});

/** Leases up to `limit` due outbox entries to the worker. */
export const claim = internalMutation({
  args: { limit: v.number() },
  returns: v.array(claimed),
  handler: async (ctx, a) => {
    const now = Date.now();
    const rows = await ctx.db.query("githubIssueMirrors").withIndex("by_pending_and_nextAt", q => q.eq("pending", true).lte("nextAt", now)).take(Math.min(Math.max(1, a.limit), 50));
    for (const row of rows) await ctx.db.patch(row._id, { leaseUntil: now + LEASE_MS, nextAt: now + LEASE_MS });
    return rows.map(row => ({ taskId: row.taskId, projectId: row.projectId, revision: row.revision, ...(row.deleted ? { deleted: row.deleted } : {}) }));
  },
});

/** Ends the worker's lease: done, failed (backs off), or "again" when the issue changed while the worker had it. */
export const finish = internalMutation({
  args: { taskId: v.id("tasks"), revision: v.number(), error: v.optional(v.string()) },
  returns: v.object({ again: v.boolean(), revision: v.number(), deleted: v.optional(v.object({ repoUrl: v.string(), number: v.number() })) }),
  handler: async (ctx, a) => {
    const row = await mirrorRow(ctx, a.taskId);
    if (!row) return { again: false, revision: a.revision };
    const now = Date.now();
    if (a.error !== undefined) {
      const attempts = row.attempts + 1;
      // A deleted issue whose project can no longer reach GitHub (repository unlinked, access revoked) stops after ~2 days.
      if (row.deleted && attempts >= 12) { await ctx.db.delete(row._id); return { again: false, revision: row.revision }; }
      await ctx.db.patch(row._id, { attempts, error: a.error.slice(0, 300), leaseUntil: undefined, nextAt: now + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 20)), updatedAt: now });
      const task = await ctx.db.get(a.taskId);
      if (task) await ctx.db.patch(task._id, { githubSyncState: "error", githubSyncError: a.error.slice(0, 300) });
      return { again: false, revision: row.revision };
    }
    if (row.revision !== a.revision) {
      await ctx.db.patch(row._id, { leaseUntil: now + LEASE_MS, nextAt: now + LEASE_MS, updatedAt: now });
      return { again: true, revision: row.revision, ...(row.deleted ? { deleted: row.deleted } : {}) };
    }
    if (row.deleted || !await ctx.db.get(a.taskId)) { await ctx.db.delete(row._id); return { again: false, revision: row.revision }; }
    await ctx.db.patch(row._id, { pending: false, attempts: 0, error: undefined, leaseUntil: undefined, updatedAt: now });
    return { again: false, revision: row.revision };
  },
});

const backfillResult = v.object({
  scanned: v.number(), eligible: v.number(), queued: v.number(),
  sample: v.array(v.object({ taskId: v.id("tasks"), projectId: v.id("projects"), title: v.string() })),
  cursor: v.string(), isDone: v.boolean(),
});

/** One page of the backfill below. */
export const backfillPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), batchSize: v.number(), dryRun: v.boolean(), includeDone: v.boolean(), projectId: v.optional(v.id("projects")) },
  returns: backfillResult,
  handler: async (ctx, a) => {
    const numItems = Math.min(Math.max(1, a.batchSize), 200);
    const projectId = a.projectId;
    const page = projectId
      ? await ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", projectId)).paginate({ cursor: a.cursor, numItems })
      : await ctx.db.query("tasks").paginate({ cursor: a.cursor, numItems });
    const projects = new Map<Id<"projects">, { project: Doc<"projects"> | null; enabled: boolean }>();
    let eligible = 0, queued = 0;
    const sample: { taskId: Id<"tasks">; projectId: Id<"projects">; title: string }[] = [];
    for (const task of page.page) {
      if (task.githubIssueNumber || (task.done && !a.includeDone)) continue;
      let entry = projects.get(task.projectId);
      if (!entry) {
        const project = await ctx.db.get(task.projectId);
        entry = { project, enabled: await githubSyncEnabled(ctx, project) };
        projects.set(task.projectId, entry);
      }
      if (!entry.enabled || !entry.project || mirrorsAsPullRequest(task, entry.project) || await taskInDraft(ctx, task)) continue;
      eligible++;
      if (sample.length < 25) sample.push({ taskId: task._id, projectId: task.projectId, title: task.title.slice(0, 80) });
      if (a.dryRun) continue;
      const row = await mirrorRow(ctx, task._id);
      if (row?.pending) continue;
      await markPending(ctx, task.projectId, task._id, undefined, false);
      queued++;
    }
    return { scanned: page.page.length, eligible, queued, sample, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Migration: queues a GitHub issue for every existing issue outside Backlog that has none, in projects that mirror to
 * GitHub (active, approved repository, not in draft-pull-request mode). Idempotent: an issue that has a GitHub issue,
 * or is already queued, is skipped, and the worker's create is marker-reconciled. `dryRun` (the default) only counts.
 * Done issues are left out unless `includeDone`. The worker creates the issues on its next tick.
 *
 *   npx convex run --prod githubIssueSync:backfillMissingIssues '{"dryRun": true}'
 *   npx convex run --prod githubIssueSync:backfillMissingIssues '{"dryRun": false}'
 */
export const backfillMissingIssues = internalAction({
  args: { dryRun: v.optional(v.boolean()), includeDone: v.optional(v.boolean()), projectId: v.optional(v.id("projects")), batchSize: v.optional(v.number()), maxPages: v.optional(v.number()) },
  returns: v.object({ dryRun: v.boolean(), pages: v.number(), scanned: v.number(), eligible: v.number(), queued: v.number(), complete: v.boolean(), sample: backfillResult.fields.sample }),
  handler: async (ctx, a) => {
    const dryRun = a.dryRun !== false;
    const totals = { scanned: 0, eligible: 0, queued: 0 };
    const sample: { taskId: Id<"tasks">; projectId: Id<"projects">; title: string }[] = [];
    let cursor: string | null = null, pages = 0, complete = false;
    while (pages < (a.maxPages ?? 1000)) {
      const page: typeof backfillResult.type = await ctx.runMutation(internal.githubIssueSync.backfillPage, {
        cursor, batchSize: a.batchSize ?? 100, dryRun, includeDone: a.includeDone === true, ...(a.projectId ? { projectId: a.projectId } : {}),
      });
      pages++;
      totals.scanned += page.scanned; totals.eligible += page.eligible; totals.queued += page.queued;
      for (const row of page.sample) if (sample.length < 25) sample.push(row);
      cursor = page.cursor;
      if (page.isDone) { complete = true; break; }
    }
    if (!dryRun && totals.queued) await ctx.scheduler.runAfter(0, internal.integrations.kick, { issues: true });
    return { dryRun, pages, ...totals, complete, sample };
  },
});
