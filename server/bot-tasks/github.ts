import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BOT_TASK_LIMITS, REPO_PATTERN, type BotTaskGithubRef } from "../../shared/bot-tasks.ts";
import { redactSecretsInText } from "../../shared/redact.ts";

const API = "https://api.github.com";
const MARKER_PREFIX = "<!-- omb-bot-task:";
const EVIDENCE_TIMEOUT_MS = 4_000;
const TOKEN_TTL = 60_000;
const execFileAsync = promisify(execFile);
type Exec = (file: string, args: string[], options: { timeout: number; encoding: "utf8" }) => Promise<{ stdout: string }>;
const ghTokens = new WeakMap<Exec, { pending: Promise<string | null>; expiresAt: number }>();

export async function resolveGithubToken(
  source: "gh" | "vault",
  saved: string | null | undefined,
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<string | null> {
  if (source === "vault") return saved?.trim() || null;
  const cached = ghTokens.get(exec);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const entry = {
    pending: Promise.resolve()
      .then(() => exec("gh", ["auth", "token"], { timeout: 5000, encoding: "utf8" }))
      .then(({ stdout }) => stdout.trim() || null, () => null)
      .finally(() => { entry.expiresAt = Date.now() + TOKEN_TTL; }),
    expiresAt: Infinity,
  };
  ghTokens.set(exec, entry);
  return entry.pending;
}

export function storedGithubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.search = "";
    return redactSecretsInText(url.toString());
  } catch { return ""; }
}

export function redactToken(text: string, token?: string | null): string {
  return (token ? text.replaceAll(token, "[REDACTED]") : text)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]");
}

export class GithubError extends Error {
  readonly status?: number;
  readonly resetAt?: number;

  constructor(message: string, status?: number, resetAt?: number, token?: string | null) {
    super(redactToken(message, token));
    this.name = "GithubError";
    this.status = status;
    this.resetAt = resetAt;
  }
}

type GithubState = "open" | "closed" | "merged";
type StateChange = "merged" | "closed" | "reopened";
type EventBase = { key: string; legacyKey?: string; at: number; login: string; ownMarker?: boolean; url: string };

export type GithubEvent = EventBase & (
  | { type: "comment"; text: string }
  | { type: "review"; state: string; text: string }
  | { type: "check"; name: string; conclusion: string }
  | { type: "state"; state: StateChange }
);

export interface GithubItem {
  kind: "pull" | "issue";
  state: GithubState;
  mergeable: boolean | null;
  headSha: string | null;
  htmlUrl: string;
  title: string;
  closedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
}

type GithubUser = { login?: string } | null;
type PullResponse = {
  state: "open" | "closed";
  merged?: boolean;
  mergeable?: boolean | null;
  head?: { sha: string };
  html_url: string;
  title: string;
  closed_at?: string | null;
  merged_at?: string | null;
  merged_by?: GithubUser;
  pull_request?: object;
};
type Comment = { id: number; user?: GithubUser; body?: string | null; created_at: string; html_url: string };
type Review = Omit<Comment, "created_at"> & { submitted_at?: string; state: string };
type Check = {
  id?: number; name: string; status: string; conclusion: string | null; completed_at: string | null;
  app?: { slug?: string } | null; html_url: string;
};
type Status = {
  id?: number; context: string; state: string; created_at: string; creator?: GithubUser; target_url?: string | null;
};
type EvidenceResponse = { sha?: string; status?: string; conclusion?: string | null; html_url?: string; run_id?: number };
type IssueEvent = { event: string; actor?: GithubUser; created_at: string };

export function ownCommentMarker(taskId: string): string {
  if (!/^[a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+)*$/.test(taskId)) throw new GithubError("Invalid bot task ID");
  return `${MARKER_PREFIX}${taskId} -->`;
}

function repoPath(repo: string, number: number): string {
  if (!REPO_PATTERN.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new GithubError("Invalid GitHub repository");
  }
  if (!Number.isSafeInteger(number) || number < 1) throw new GithubError("Invalid GitHub issue or pull request number");
  return `/repos/${repo}`;
}

function rateLimitReset(headers: Headers, now: () => number): number | undefined {
  const retry = headers.get("retry-after");
  const reset = headers.get("x-ratelimit-reset");
  if (retry && /^\d+$/.test(retry)) return now() + Number(retry) * 1000;
  if (retry && Number.isFinite(Date.parse(retry))) return Date.parse(retry);
  if (reset && /^\d+$/.test(reset)) return Number(reset) * 1000;
}

function paginationLink(headers: Headers, current: URL, relation: "next" | "last" | "prev"): URL | undefined {
  const link = headers.get("link")?.split(/,\s*(?=<)/)
    .find((part) => part.endsWith(`rel="${relation}"`))?.match(/^\s*<([^>]+)>/)?.[1];
  if (!link) return;
  let next: URL;
  try {
    next = new URL(link, current);
  } catch {
    return;
  }
  if (next.origin !== API || next.username || next.password || !next.search || next.search === current.search) return;
  // GitHub pagination may use /repositories/{id} instead of /repos/{owner}/{repo}.
  const page = new URL(current);
  for (const [name, value] of next.searchParams) page.searchParams.set(name, value);
  if (page.href !== current.href) return page;
}

export function createGithubClient({
  token,
  fetch: fetchImpl = fetch,
  now = Date.now,
}: {
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  async function request<T>(
    url: string | URL,
    method = "GET",
    body?: object,
    sanitize?: (data: T, credential: string) => T,
    timeout = 15_000,
  ): Promise<{ data: T; headers: Headers }> {
    let credential: string | null;
    try {
      credential = await token();
    } catch {
      throw new GithubError("GitHub token missing or invalid", 401);
    }
    if (!credential) throw new GithubError("GitHub token missing or invalid", 401);
    let response: Response;
    try {
      response = await fetchImpl(new URL(url, API), {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "openmausbot-bot-tasks",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch {
      throw new GithubError("GitHub network request failed", undefined, undefined, credential);
    }
    const { headers, status } = response;
    if (!response.ok) {
      if (status === 403 || status === 429) {
        const resetAt = rateLimitReset(headers, now);
        const details = status === 403
          ? await response.json().catch(() => null) as { message?: unknown } | null
          : null;
        if (status === 429) await response.body?.cancel().catch(() => {});
        const remaining = headers.get("x-ratelimit-remaining");
        const limited = status === 429 || headers.has("retry-after") || remaining === "0" ||
          (remaining === null && resetAt !== undefined) ||
          (typeof details?.message === "string" && /rate limit/i.test(details.message));
        throw new GithubError(limited ? "GitHub rate limit exceeded" : "GitHub access forbidden", status, limited ? resetAt : undefined);
      }
      await response.body?.cancel().catch(() => {});
      if (status === 401) throw new GithubError("GitHub token missing or invalid", status);
      if (status === 404) throw new GithubError("GitHub resource not found", status);
      throw new GithubError(`GitHub request failed (HTTP ${status})`, status);
    }
    try {
      const data = await response.json() as T;
      return { data: sanitize ? sanitize(data, credential) : data, headers };
    } catch {
      throw new GithubError("GitHub returned an unreadable response", status);
    }
  }

  async function pages<T, Page = T[]>(path: string, extract: (page: Page) => T[], newest = false, timeout?: number): Promise<T[]> {
    let url: URL | undefined = new URL(path, API);
    url.searchParams.set("per_page", "100");
    const batches: T[][] = [];
    let backwards = false;
    const visited = new Set<string>();
    for (let page = 0; url && page < 5 && !visited.has(url.href); page++) {
      visited.add(url.href);
      const result: { data: Page; headers: Headers } = await request<Page>(url, "GET", undefined, undefined, timeout);
      if (backwards) batches.splice(1, 0, extract(result.data));
      else batches.push(extract(result.data));
      const last: URL | undefined = newest && page === 0 ? paginationLink(result.headers, url, "last") : undefined;
      if (last) backwards = true;
      url = last ?? paginationLink(result.headers, url, backwards ? "prev" : "next");
    }
    return batches.flat();
  }

  async function viewer(): Promise<string> {
    return (await request<{ login: string }>("/user")).data.login;
  }

  async function pull(repo: string, number: number, timeout?: number): Promise<GithubItem> {
    const path = repoPath(repo, number);
    let kind: GithubItem["kind"] = "pull";
    let item: PullResponse;
    try {
      item = (await request<PullResponse>(`${path}/pulls/${number}`, "GET", undefined, undefined, timeout)).data;
    } catch (error) {
      if (!(error instanceof GithubError && error.status === 404)) throw error;
      kind = "issue";
      item = (await request<PullResponse>(`${path}/issues/${number}`, "GET", undefined, undefined, timeout)).data;
      if (item.pull_request) throw new GithubError("GitHub pull request access is unavailable", 403);
    }
    return {
      kind,
      state: item.merged ? "merged" : item.state,
      mergeable: kind === "pull" ? item.mergeable ?? null : null,
      headSha: kind === "pull" ? item.head?.sha ?? null : null,
      htmlUrl: item.html_url,
      title: item.title,
      closedAt: item.closed_at ?? undefined,
      mergedAt: item.merged_at ?? undefined,
      mergedBy: item.merged_by?.login,
    };
  }

  async function events(ref: BotTaskGithubRef, sinceMs: number, item?: GithubItem): Promise<GithubEvent[]> {
    const path = repoPath(ref.repo, ref.number);
    const issue = `${path}/issues/${ref.number}`;
    const pr = `${path}/pulls/${ref.number}`;
    const since = new URLSearchParams({ since: new Date(sinceMs).toISOString() });
    const snapshot = item ?? await pull(ref.repo, ref.number);
    const [comments, issueEvents, reviewComments, reviews, checkEvents] = await Promise.all([
      pages(`${issue}/comments?${since}`, (page: Comment[]) => page, true),
      pages(`${issue}/events`, (page: IssueEvent[]) => page, true),
      snapshot.kind === "pull" ? pages(`${pr}/comments?${since}`, (page: Comment[]) => page, true) : [],
      snapshot.kind === "pull" ? pages(`${pr}/reviews`, (page: Review[]) => page, true) : [],
      snapshot.headSha ? pullChecks(path, pr, snapshot.headSha, sinceMs === 0) : [],
    ]);
    const activity: GithubEvent[] = [];
    for (const [prefix, group] of [["comment", comments], ["review-comment", reviewComments]] as const) {
      for (const comment of group) {
        const at = Date.parse(comment.created_at);
        if (!Number.isFinite(at) || at < sinceMs) continue;
        const body = comment.body ?? "";
        activity.push({
          type: "comment", key: `${prefix}:${comment.id}`, at, login: comment.user?.login ?? "github",
          ...(prefix === "review-comment" ? { legacyKey: `comment:${comment.id}` } : {}),
          ownMarker: body.includes(MARKER_PREFIX), text: redactSecretsInText(body).slice(0, BOT_TASK_LIMITS.textMax), url: comment.html_url,
        });
      }
    }
    for (const review of reviews) {
      const at = Date.parse(review.submitted_at ?? "");
      if (!Number.isFinite(at) || at < sinceMs) continue;
      activity.push({
        type: "review", key: `review:${review.id}`, at, login: review.user?.login ?? "github",
        state: review.state, text: redactSecretsInText(review.body ?? "").slice(0, BOT_TASK_LIMITS.textMax), url: review.html_url,
      });
    }
    activity.push(...stateEvents(snapshot, issueEvents), ...checkEvents);
    return activity.filter((event) => event.at >= sinceMs).sort((a, b) => a.at - b.at);
  }

  async function pullChecks(path: string, pr: string, head: string, backfill: boolean): Promise<GithubEvent[]> {
    if (!backfill) return checks(path, head);
    const commits = await pages(`${pr}/commits`, (page: Array<{ sha: string }>) => page, true);
    const earlier = [...new Set(commits.map(({ sha }) => sha))].filter((sha) => sha !== head).slice(-3);
    const history = await Promise.all([
      checks(path, head),
      ...earlier.map(async (sha) => {
        try { return await checks(path, sha); }
        catch (error) {
          if (error instanceof GithubError && error.status === 404) return [];
          throw error;
        }
      }),
    ]);
    return history.flat();
  }

  async function checks(path: string, sha: string): Promise<GithubEvent[]> {
    const commit = `${path}/commits/${encodeURIComponent(sha)}`;
    const [runs, statuses] = await Promise.all([
      pages(`${commit}/check-runs?filter=all`, (page: { check_runs: Check[] }) => page.check_runs),
      pages(`${commit}/statuses`, (page: Status[]) => page),
    ]);
    const activity: GithubEvent[] = [];
    function record(key: string, name: string, conclusion: string, at: number, login: string, url: string) {
      if (!Number.isFinite(at)) return;
      activity.push({ type: "check", key, legacyKey: `check:${name}:${sha}:${conclusion}`, at, login, name, conclusion, url });
    }
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion) {
        record(run.id === undefined ? `check:${run.name}:${sha}:${run.conclusion}` : `check-run:${run.id}`, run.name, run.conclusion, Date.parse(run.completed_at ?? ""), run.app?.slug ?? "github", run.html_url);
      }
    }
    for (const status of statuses) {
      if (status.state !== "pending") {
        record(status.id === undefined ? `check:${status.context}:${sha}:${status.state}` : `commit-status:${status.id}`, status.context, status.state, Date.parse(status.created_at),
          status.creator?.login ?? "github", status.target_url ?? "");
      }
    }
    return activity;
  }

  async function postComment(ref: BotTaskGithubRef & { taskId: string }, text: string): Promise<{ id: number; url: string }> {
    const path = repoPath(ref.repo, ref.number);
    const { data } = await request<{ id: number; html_url: string }>(`${path}/issues/${ref.number}/comments`, "POST", {
      body: `${text}\n\n${ownCommentMarker(ref.taskId)}`,
    });
    return { id: data.id, url: data.html_url };
  }

  async function merge(
    ref: BotTaskGithubRef, { sha, method }: { sha: string; method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    const path = repoPath(ref.repo, ref.number);
    const { data } = await request<{ merged: boolean; sha: string; message: string }>(
      `${path}/pulls/${ref.number}/merge`, "PUT", { sha, merge_method: method },
      ({ merged, sha, message }, credential) => ({ merged, sha, message: redactToken(message, credential) }),
    );
    return data;
  }

  async function pullCommitEvidence(ref: BotTaskGithubRef): Promise<{ shas: string[]; complete: boolean } | null> {
    if ((await pull(ref.repo, ref.number, EVIDENCE_TIMEOUT_MS)).kind === "issue") return null;
    const path = `${repoPath(ref.repo, ref.number)}/pulls/${ref.number}/commits`;
    const commits = await pages(path, (page: Array<{ sha: string }>) => page, false, EVIDENCE_TIMEOUT_MS);
    return { shas: commits.map(({ sha }) => sha), complete: commits.length < 250 };
  }

  async function lookupEvidence(path: string): Promise<EvidenceResponse> {
    if (!path.startsWith("/repos/")) throw new GithubError("Invalid GitHub evidence endpoint");
    return (await request<EvidenceResponse>(
      path, "GET", undefined, undefined, EVIDENCE_TIMEOUT_MS,
    )).data;
  }

  return { viewer, pull, events, postComment, merge, lookupEvidence, pullCommitEvidence };
}

export type GithubClient = ReturnType<typeof createGithubClient>;

function stateEvents(item: GithubItem, events: IssueEvent[]): GithubEvent[] {
  const activity: GithubEvent[] = [];
  const timestamps = new Set<string>();
  function record(state: StateChange, timestamp: string, login: string) {
    const at = Date.parse(timestamp);
    const key = state === "merged" ? "state:merged" : `state:${state}:${state === "closed" ? timestamp : at}`;
    if (!Number.isFinite(at) || timestamps.has(key)) return;
    timestamps.add(key);
    activity.push({ type: "state", state, key, at, login, url: item.htmlUrl });
  }
  if (item.mergedAt) record("merged", item.mergedAt, item.mergedBy ?? "github");
  for (const event of events) {
    if (event.event === "reopened" || event.event === "closed" || event.event === "merged") {
      record(event.event, event.created_at, event.actor?.login ?? "github");
    }
  }
  if (item.state === "closed" && item.closedAt) record("closed", item.closedAt, "github");
  return activity;
}
