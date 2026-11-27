// The bot task ledger: tasks, their append-only log, the evidence rule, inbound GitHub sync and the explicit outbound
// comment. Storage is `bot-tasks.json`; every change is saved before it is announced to `onChange` listeners.
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  BOT_TASK_LIMITS, type BotTask, type BotTaskActivity, type BotTaskActivityBody, type BotTaskActor, type BotTaskEvidence, type BotTaskGithubRef, type BotTaskStatus,
  type BotTasksSettings, type BotTaskSummary,
} from "../../shared/bot-tasks.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { BotTaskError, evidenceStatus, githubRefsIn, parseEvidence, parseRef, refLabel, supportsDone, verifyEvidence } from "./evidence.ts";
import { GithubError, storedGithubUrl, type GithubClient } from "./github.ts";
import { repoAllowed } from "./settings.ts";
import { BOT_TASKS_FILE, readBotTasksFile, writeBotTasksFile } from "./store.ts";

/** An imported GitHub event: the activity payload plus the key that stops a later poll from adding it twice. */
export type ImportedActivity = { key: string; at: number; by: BotTaskActor } & (
  | { type: "github_comment"; text: string; url?: string }
  | { type: "github_review"; state: string; text: string; url?: string }
  | { type: "github_check"; name: string; conclusion: string; url?: string }
  | { type: "github_state"; state: "merged" | "closed" | "reopened"; url?: string }
);

export interface GithubSyncResult {
  ref: BotTaskGithubRef;
  githubState: { state: "open" | "closed" | "merged" };
  activity: ImportedActivity[];
}

/** What the service needs of GitHub; server/bot-tasks/wiring.ts builds it from the GitHub client. `taskId` goes into the
 * comment as a hidden marker, so a later sync knows the comment is this app's own. */
export interface GithubPort {
  sync(task: BotTask, since: number): Promise<GithubSyncResult>;
  lookupEvidence: GithubClient["lookupEvidence"];
  pullCommitEvidence: GithubClient["pullCommitEvidence"];
  pull(ref: BotTaskGithubRef): Promise<{ kind: "pull" | "issue"; state: "open" | "closed" | "merged"; mergeable: boolean | null; headSha: string | null; htmlUrl: string }>;
  postComment(ref: BotTaskGithubRef, text: string, taskId: string): Promise<{ id: string | number; url: string }>;
  merge(ref: BotTaskGithubRef, headSha: string): Promise<{ merged: boolean; sha?: string; message?: string }>;
}

export interface BotTasksDeps {
  dataDir: string;
  file?: string;
  now?: () => number;
  settings(): BotTasksSettings;
  botName(botId: string): string | undefined;
  /** Null when no GitHub credential is usable now. */
  github(): GithubPort | null;
  log?(text: string): void;
}

export interface TaskFilter {
  status?: BotTaskStatus | readonly BotTaskStatus[];
  botId?: string;
  repo?: string;
  query?: string;
  limit?: number;
}

const OPEN_STATUSES: readonly BotTaskStatus[] = ["open", "in_progress", "blocked", "review"];
const RECENT_DONE_MS = 7 * 24 * 3_600_000;
const SYNC_OVERLAP_MS = 60_000;
const clean = (text: string, max: number) => redactSecretsInText(text).trim().slice(0, max);

export function createBotTasks(deps: BotTasksDeps) {
  const file = deps.file ?? join(deps.dataDir, BOT_TASKS_FILE);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((text: string) => console.error(text));
  let tasks: BotTask[] | null = null;
  const listeners = new Set<(taskId: string) => void>();
  const posting = new Set<string>();
  const syncing = new Map<string, { linkId: string | undefined; pending: Promise<{ added: number; task: BotTask }> }>();

  const loaded = (): BotTask[] => (tasks ??= readBotTasksFile(file));
  const save = (next: BotTask[], changed: readonly string[]) => {
    writeBotTasksFile(file, next);
    tasks = next;
    for (const id of changed) for (const listener of listeners) {
      try { listener(id); } catch (error) { log(`bot-tasks: a listener failed: ${String(error)}`); }
    }
  };
  const found = (id: string): BotTask => {
    const task = loaded().find((candidate) => candidate.id === id);
    if (!task) throw new BotTaskError(404, `No task has the id ${id}. Use task_list for the ids.`);
    return task;
  };
  const activity = (by: BotTaskActor, body: BotTaskActivityBody, at = now(), key?: string): BotTaskActivity =>
    ({ id: `a_${randomUUID().slice(0, 8)}`, at, by, ...(key ? { key } : {}), ...body }) as BotTaskActivity;
  const capLog = (entries: BotTaskActivity[]): BotTaskActivity[] => {
    const over = entries.length - BOT_TASK_LIMITS.activityMax;
    if (over <= 0) return entries;
    const fromGithub = (entry: BotTaskActivity) => entry.by.kind === "github" || entry.type === "sync_error";
    const link = entries.findLast((entry) => entry.type === "github_ref");
    const droppable = new Set([
      ...entries.filter(fromGithub),
      ...entries.filter((entry) => entry.type === "comment"),
      ...entries.filter((entry) => !fromGithub(entry) && entry.type !== "created" && entry.type !== "comment" && entry !== link),
    ].slice(0, over));
    return entries.filter((entry) => !droppable.has(entry));
  };
  /** Replaces one task with the result of `change`; the log gets `added`. */
  const commit = (id: string, change: (task: BotTask) => BotTask, added: BotTaskActivity[], at = now()): BotTask => {
    const current = found(id);
    const next = change({ ...current, activity: current.activity });
    const updated: BotTask = { ...next, updatedAt: at, activity: capLog([...next.activity, ...added].sort((a, b) => a.at - b.at)) };
    save(loaded().map((task) => (task.id === id ? updated : task)), [id]);
    return updated;
  };
  const summary = (task: BotTask): BotTaskSummary => {
    const { activity: entries, evidence, ...rest } = task;
    const status = evidenceStatus(evidence);
    return {
      ...rest, ownerName: deps.botName(task.ownerBotId) ?? task.ownerBotId, activityCount: entries.length,
      ...(evidence?.length ? { evidenceCount: evidence.length } : {}), ...(status ? { evidenceStatus: status } : {}),
    };
  };
  const mayChange = (task: BotTask, by: BotTaskActor) => by.kind !== "bot" || by.id === task.ownerBotId || (task.createdBy.kind === "bot" && task.createdBy.id === by.id);
  const needOwn = (task: BotTask, by: BotTaskActor, what: string) => {
    if (!mayChange(task, by)) throw new BotTaskError(403, `Only ${deps.botName(task.ownerBotId) ?? "the owner"} or the bot that created this task may ${what}. You can add a comment.`);
  };

  /** A reference a text names, when it names exactly one and the task has none yet. */
  const autoRef = (task: BotTask, texts: readonly string[]): { ref?: BotTaskGithubRef; candidates: BotTaskGithubRef[] } => {
    const candidates = githubRefsIn(texts.join("\n"));
    return task.github || candidates.length !== 1 ? { candidates: task.github ? [] : candidates } : { ref: candidates[0]!, candidates };
  };
  const withRef = (task: BotTask, ref: BotTaskGithubRef, by: BotTaskActor, at: number): { task: BotTask; entry: BotTaskActivity } =>
    ({ task: { ...task, github: ref }, entry: activity(by, { type: "github_ref", ref }, at) });

  const outbound = (id: string, expectedRef: BotTaskGithubRef, merge: boolean) => {
    const settings = deps.settings();
    if (!settings.allowOutboundComments) throw new BotTaskError(403, "Posting to GitHub is off in Settings → Bot tasks.");
    if (merge && !settings.allowMerge) throw new BotTaskError(403, "Merging is off in Settings → Bot tasks.");
    const ref = found(id).github;
    if (!ref || refLabel(ref).toLowerCase() !== refLabel(expectedRef).toLowerCase()) {
      throw new BotTaskError(409, "The task's GitHub link changed. Review the current link and confirm again.");
    }
    if (!repoAllowed(settings, ref.repo)) throw new BotTaskError(403, `${ref.repo} is outside the repository allowlist.`);
    const github = deps.github();
    if (!github) throw new BotTaskError(503, "No GitHub credential is usable. Check Settings → Bot tasks.");
    return { ref, github };
  };

  const mergeHead = async (ref: BotTaskGithubRef, github: GithubPort) => {
    const pull = await github.pull(ref);
    if (pull.kind !== "pull") throw new BotTaskError(409, `${refLabel(ref)} is an issue and cannot be merged.`);
    if (pull.state !== "open") throw new BotTaskError(409, `${refLabel(ref)} is already ${pull.state}.`);
    if (pull.mergeable === false) throw new BotTaskError(409, `${refLabel(ref)} is not mergeable now.`);
    if (!pull.headSha) throw new BotTaskError(409, "The pull request head is unavailable. Refresh and confirm again.");
    return { sha: pull.headSha, url: pull.htmlUrl };
  };

  const latestLink = (task: BotTask) => task.activity.findLast((entry) => entry.type === "github_ref");
  const startBackfill = (task: BotTask) => {
    const settings = deps.settings();
    if (!task.github || !settings.enabled || !settings.githubSync || !repoAllowed(settings, task.github.repo) || !deps.github()) return;
    void api.sync(task.id).catch(() => {});
  };

  const api = {
    onChange(listener: (taskId: string) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    create(input: { title: string; ownerBotId: string; by: BotTaskActor; github?: string; text?: string }): { task: BotTask; suggested: BotTaskGithubRef[] } {
      const title = clean(input.title, BOT_TASK_LIMITS.titleMax).replace(/\s+/g, " ");
      if (!title) throw new BotTaskError(400, "A task needs a title.");
      if (!deps.botName(input.ownerBotId)) throw new BotTaskError(400, `No bot has the id ${input.ownerBotId}. Use list_bots for the ids.`);
      if (loaded().length >= BOT_TASK_LIMITS.tasksMax) throw new BotTaskError(409, `The ledger holds ${BOT_TASK_LIMITS.tasksMax} tasks, the most it may. Cancel or finish some first.`);
      const at = now();
      const text = input.text ? clean(input.text, BOT_TASK_LIMITS.textMax) : "";
      let task: BotTask = { id: `tsk_${randomUUID().replaceAll("-", "").slice(0, 8)}`, title, status: "open", ownerBotId: input.ownerBotId, createdBy: input.by, createdAt: at, updatedAt: at, activity: [] };
      const added: BotTaskActivity[] = [activity(input.by, { type: "created" }, at)];
      if (text) added.push(activity(input.by, { type: "comment", text }, at));
      const explicit = input.github ? parseRef(input.github) : undefined;
      const { ref, candidates } = explicit ? { ref: explicit, candidates: [] } : autoRef(task, [title, text]);
      if (ref) {
        const linked = withRef(task, ref, { kind: "system" }, at);
        task = linked.task;
        added.push(linked.entry);
      }
      task = { ...task, activity: added };
      save([...loaded(), task], [task.id]);
      if (ref) startBackfill(task);
      return { task, suggested: ref ? [] : candidates };
    },

    comment(id: string, text: string, by: BotTaskActor): { task: BotTask; suggested: BotTaskGithubRef[] } {
      const body = clean(text, BOT_TASK_LIMITS.textMax);
      if (!body) throw new BotTaskError(400, "A comment needs text.");
      const at = now();
      const before = found(id);
      const { ref, candidates } = autoRef(before, [body]);
      if (ref) needOwn(before, by, "link it to GitHub");
      const entries = [activity(by, { type: "comment", text: body }, at)];
      const task = commit(id, (current) => {
        if (!ref) return current;
        const linked = withRef(current, ref, { kind: "system" }, at);
        entries.push(linked.entry);
        return linked.task;
      }, entries, at);
      if (ref) startBackfill(task);
      return { task, suggested: ref ? [] : candidates };
    },

    async setStatus(id: string, input: { status: BotTaskStatus; evidence?: unknown; comment?: string; ownerBotId?: string; by: BotTaskActor }): Promise<BotTask> {
      const before = found(id);
      needOwn(before, input.by, "change its status");
      if (input.ownerBotId && !deps.botName(input.ownerBotId)) throw new BotTaskError(400, `No bot has the id ${input.ownerBotId}. Use list_bots for the ids.`);
      const settings = deps.settings();
      const rawEvidence = input.evidence === undefined ? [] : input.evidence;
      if (!Array.isArray(rawEvidence)) throw new BotTaskError(400, "evidence is a list of items.");
      if (rawEvidence.length > BOT_TASK_LIMITS.evidencePerMove) throw new BotTaskError(400, `At most ${BOT_TASK_LIMITS.evidencePerMove} evidence items per move.`);
      const claims = rawEvidence.map(parseEvidence);
      const moved = before.status !== input.status;
      const ownerChanged = input.ownerBotId !== undefined && input.ownerBotId !== before.ownerBotId;
      if (!moved && !input.comment && !ownerChanged) throw new BotTaskError(409, `The task is already ${input.status}.`);
      const comment = input.comment ? clean(input.comment, BOT_TASK_LIMITS.textMax) : "";
      const link = autoRef(before, [comment, ...claims.flatMap((item) => (item.kind === "review_url" || item.kind === "ci_run" ? [item.url] : []))]);
      const verify = moved && (input.status === "done" || (input.status === "review" && settings.requireEvidenceForReview));
      let evidence: BotTaskEvidence[] = claims;
      if (verify && claims.length) {
        const github = deps.github();
        const ref = before.github ?? link.ref;
        const checkedAt = now();
        let pullCommits: ReturnType<GithubClient["pullCommitEvidence"]> | undefined;
        const loadPullCommits = github && ref ? () => (pullCommits ??= github.pullCommitEvidence(ref)) : undefined;
        evidence = await Promise.all(claims.map((claim) => verifyEvidence(claim, ref, settings, github?.lookupEvidence, checkedAt, loadPullCommits)));
        const failed = evidence.find((item) => item.verification?.status === "failed");
        if (failed) throw new BotTaskError(422, `Blocked: ${failed.verification?.detail}`);
      }
      const latestSettings = deps.settings();
      const required = (input.status === "done" && latestSettings.requireEvidenceForDone) ||
        (input.status === "review" && latestSettings.requireEvidenceForReview);
      for (const item of evidence) {
        if (item.verification?.status !== "verified") continue;
        const repo = before.github?.repo ?? link.ref?.repo ?? (item.kind === "commit" ? item.repo : undefined);
        if (repo && !repoAllowed(latestSettings, repo)) throw new BotTaskError(409, "The GitHub allowlist changed during verification. Review Settings and retry.");
      }
      if (moved && required && !supportsDone(evidence)) {
        const issue = evidence.find((item) => item.verification?.status === "unverifiable")?.verification?.detail;
        throw new BotTaskError(422, `Moving a task to ${input.status} needs evidence: a verified commit, CI run or review link, or a recorded command with exit code 0.${issue ? ` ${issue}` : ""}`);
      }
      const current = found(id);
      if (before.status !== current.status || before.ownerBotId !== current.ownerBotId || latestLink(before)?.id !== latestLink(current)?.id) {
        throw new BotTaskError(409, "The task changed during verification. Read it again before retrying.");
      }
      const at = now();
      const entries: BotTaskActivity[] = [];
      if (moved) entries.push(activity(input.by, { type: "status", from: before.status, to: input.status, ...(evidence.length ? { evidence } : {}) }, at));
      if (ownerChanged) entries.push(activity(input.by, { type: "owner", from: before.ownerBotId, to: input.ownerBotId! }, at));
      if (comment) entries.push(activity(input.by, { type: "comment", text: comment }, at));
      const task = commit(id, (currentTask) => {
        const updated = {
          ...currentTask, status: input.status, ownerBotId: input.ownerBotId ?? currentTask.ownerBotId,
          ...(moved ? { evidence: evidence.length ? evidence : undefined } : {}),
        };
        if (!link.ref) return updated;
        const linked = withRef(updated, link.ref, { kind: "system" }, at);
        entries.push(linked.entry);
        return linked.task;
      }, entries, at);
      if (link.ref) startBackfill(task);
      return task;
    },

    setOwner(id: string, ownerBotId: string, by: BotTaskActor): BotTask {
      const before = found(id);
      needOwn(before, by, "hand it to another bot");
      if (!deps.botName(ownerBotId)) throw new BotTaskError(400, `No bot has the id ${ownerBotId}. Use list_bots for the ids.`);
      if (before.ownerBotId === ownerBotId) return before;
      return commit(id, (current) => ({ ...current, ownerBotId }), [activity(by, { type: "owner", from: before.ownerBotId, to: ownerBotId })]);
    },

    linkGithub(id: string, rawRef: string, by: BotTaskActor): BotTask {
      const ref = parseRef(rawRef);
      const before = found(id);
      needOwn(before, by, "change its GitHub link");
      if (before.github && refLabel(before.github).toLowerCase() === refLabel(ref).toLowerCase()) return before;
      if (posting.has(id)) throw new BotTaskError(409, "A GitHub post is in progress. Try again when it finishes.");
      const at = now();
      const linked = commit(id, (current) => {
        const { githubState: _old, ...rest } = current;
        return { ...rest, github: ref };
      }, [activity(by, { type: "github_ref", ref }, at)], at);
      startBackfill(linked);
      return linked;
    },

    list(filter: TaskFilter = {}): BotTaskSummary[] {
      const statuses = filter.status === undefined ? undefined : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
      const words = filter.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      return loaded()
        .filter((task) => (!statuses || statuses.has(task.status)) && (!filter.botId || task.ownerBotId === filter.botId)
          && (!filter.repo || task.github?.repo.toLowerCase() === filter.repo.toLowerCase())
          && words.every((word) => `${task.title} ${task.id} ${task.github ? refLabel(task.github) : ""} ${deps.botName(task.ownerBotId) ?? ""}`.toLowerCase().includes(word)))
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, filter.limit ?? BOT_TASK_LIMITS.tasksMax).map(summary);
    },

    get(id: string): BotTask & { ownerName: string } {
      const task = found(id);
      return { ...task, ownerName: deps.botName(task.ownerBotId) ?? task.ownerBotId };
    },

    /** Pulls one task's GitHub activity into its log. `force` also works while the polling switch is off. */
    async sync(id: string, options: { force?: boolean } = {}): Promise<{ added: number; task: BotTask }> {
      const task = found(id);
      const settings = deps.settings();
      if (!task.github) throw new BotTaskError(409, "This task has no GitHub reference. Link one first.");
      if (!settings.githubSync && !options.force) throw new BotTaskError(403, "GitHub sync is off. Turn it on in Settings → Bot tasks.");
      if (!repoAllowed(settings, task.github.repo)) throw new BotTaskError(403, `${task.github.repo} is not on the allowed repositories of Settings → Bot tasks, so nothing is read from it.`);
      const github = deps.github();
      if (!github) throw new BotTaskError(503, "No GitHub credential is usable. Choose the gh CLI or save a token in Settings → Bot tasks.");
      const link = latestLink(task);
      const linkId = link?.id;
      const running = syncing.get(id);
      if (running && running.linkId === linkId) return running.pending;
      const linkAt = link?.at ?? task.createdAt;
      const syncStartedAt = now();
      const since = task.githubState?.historyBackfilled ? Math.max(1, task.githubState.syncedAt - SYNC_OVERLAP_MS) : 0;
      const currentLink = () => latestLink(found(id))?.id === linkId;
      const pending = (async () => {
        let result: GithubSyncResult;
        try {
          result = await github.sync(task, since);
        } catch (error) {
          if (!currentLink()) return { added: 0, task: found(id) };
          const text = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 300);
          const last = found(id).activity.findLast((entry) => entry.type === "sync_error");
          if (!last || last.type !== "sync_error" || last.text !== text) commit(id, (current) => current, [activity({ kind: "system" }, { type: "sync_error", text })]);
          throw new BotTaskError(502, `GitHub sync failed: ${text}`);
        }
        const current = found(id);
        if (!currentLink()) return { added: 0, task: current };
        const have = new Set(current.activity.map((entry) => entry.key));
        const entries: BotTaskActivity[] = [];
        for (const { key, at, by, ...body } of result.activity) {
          if (at < since || have.has(key)) continue;
          have.add(key);
          if ("text" in body) body.text = clean(body.text, BOT_TASK_LIMITS.textMax);
          if (body.url) body.url = storedGithubUrl(body.url) || undefined;
          entries.push({ ...activity(by, body, at, key), ...(at < linkAt ? { imported: true } : {}) });
        }
        const retained = new Set(capLog([...current.activity, ...entries].sort((a, b) => a.at - b.at)));
        const added = entries.filter((entry) => retained.has(entry)).length;
        const updated = commit(id, (current) => ({
          ...current, github: result.ref,
          githubState: { state: result.githubState.state, syncedAt: syncStartedAt, historyBackfilled: true },
        }), entries, added ? now() : current.updatedAt);
        return { added, task: updated };
      })();
      syncing.set(id, { linkId, pending });
      try {
        return await pending;
      } finally {
        if (syncing.get(id)?.pending === pending) syncing.delete(id);
      }
    },

    /** One poll round over the tasks with a GitHub reference that are open or lately finished and on an allowed repository. */
    async syncAll(): Promise<{ checked: number; added: number; errors: number }> {
      const settings = deps.settings();
      if (!settings.enabled || !settings.githubSync || !deps.github()) return { checked: 0, added: 0, errors: 0 };
      const cutoff = now() - RECENT_DONE_MS;
      const due = loaded().filter((task) => task.github && repoAllowed(settings, task.github.repo) && (OPEN_STATUSES.includes(task.status) || task.updatedAt >= cutoff));
      const result = { checked: 0, added: 0, errors: 0 };
      for (const task of due) {
        result.checked += 1;
        try {
          result.added += (await this.sync(task.id)).added;
        } catch (error) {
          result.errors += 1;
          log(`bot-tasks: sync of ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof BotTaskError && error.status === 502 && /rate limit/i.test(error.message)) break;
        }
      }
      return result;
    },

    async prepareMerge(id: string, expectedRef: BotTaskGithubRef): Promise<{ sha: string }> {
      const { ref, github } = outbound(id, expectedRef, true);
      const head = await mergeHead(ref, github);
      outbound(id, expectedRef, true);
      return { sha: head.sha };
    },

    async post(id: string, input: { text: string; expectedRef: BotTaskGithubRef; mergeHead?: string; by: Extract<BotTaskActor, { kind: "person" }> }): Promise<{ url: string; merged: boolean; task: BotTask }> {
      const { ref, github } = outbound(id, input.expectedRef, Boolean(input.mergeHead));
      const text = clean(input.text, BOT_TASK_LIMITS.textMax);
      if (!text) throw new BotTaskError(400, "The comment needs text.");
      if (posting.has(id)) throw new BotTaskError(409, "A post for this task is already running.");
      posting.add(id);
      let merged = false;
      try {
        if (input.mergeHead) {
          const head = await mergeHead(ref, github);
          if (head.sha !== input.mergeHead) throw new BotTaskError(409, "The pull request head changed. Review it and confirm again.");
          outbound(id, input.expectedRef, true);
          const result = await github.merge(ref, input.mergeHead).catch((error: unknown) => {
            if (error instanceof GithubError && error.status === 409) throw new BotTaskError(409, "The pull request changed. Review it and confirm again.");
            throw error;
          });
          if (!result.merged) throw new BotTaskError(502, `GitHub did not merge ${refLabel(ref)}: ${clean(result.message ?? "no reason given", 200)}.`);
          merged = true;
          const key = `${refLabel(ref).toLowerCase()}:state:merged`;
          if (!found(id).activity.some((entry) => entry.key === key)) {
            commit(id, (current) => ({
              ...current, githubState: { syncedAt: 0, ...current.githubState, state: "merged" },
            }), [activity(input.by, { type: "github_state", state: "merged", url: storedGithubUrl(head.url) }, now(), key)]);
          }
        }
        const posted = await github.postComment(ref, text, id).catch((error: unknown) => {
          if (merged) throw new BotTaskError(502, "GitHub merged the pull request, but the comment could not be confirmed. Check GitHub before retrying the comment.", "merge_completed");
          throw error;
        });
        const url = storedGithubUrl(posted.url);
        const updated = commit(id, (current) => current, [activity(input.by, { type: "posted", url, ...(merged ? { merged: true } : {}) }, now(), `comment:${posted.id}`)]);
        return { url, merged, task: updated };
      } finally {
        posting.delete(id);
      }
    },
  };
  return api;
}

export type BotTasks = ReturnType<typeof createBotTasks>;
