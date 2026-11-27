import type { BotTaskEvidence, BotTaskEvidenceClaim, BotTaskGithubRef, BotTasksSettings, BotTaskVerification } from "../../shared/bot-tasks.ts";
import { REPO_PATTERN } from "../../shared/bot-tasks.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { GithubError, storedGithubUrl, type GithubClient } from "./github.ts";
import { repoAllowed } from "./settings.ts";

export class BotTaskError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const EVIDENCE_EXAMPLE = 'Example: evidence [{"kind":"commit","sha":"<40-hex>"}, {"kind":"ci_run","url":"https://github.com/o/r/actions/runs/123"}, {"kind":"review_url","url":"https://github.com/o/r/pull/7#pullrequestreview-1"}, {"kind":"command","command":"pnpm test","exitCode":0}].';

const SHA = /^[0-9a-f]{7,40}$/i;

function httpsUrl(raw: unknown, what: string): URL {
  if (typeof raw !== "string") throw new BotTaskError(400, `${what} needs a URL. ${EVIDENCE_EXAMPLE}`);
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new BotTaskError(400, `${what} needs a valid URL.`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new BotTaskError(400, `${what} must be a plain https URL.`);
  return url;
}

/** Checks one evidence item's shape. It proves that a claim names something checkable, not that the thing exists. */
export function parseEvidence(raw: unknown): BotTaskEvidenceClaim {
  if (!raw || typeof raw !== "object") throw new BotTaskError(400, `Each evidence item is an object. ${EVIDENCE_EXAMPLE}`);
  const item = raw as Record<string, unknown>;
  switch (item.kind) {
    case "commit": {
      if (typeof item.sha !== "string" || !SHA.test(item.sha.trim())) throw new BotTaskError(400, `A commit needs a hex sha of 7 to 40 characters. ${EVIDENCE_EXAMPLE}`);
      const repo = typeof item.repo === "string" && item.repo.trim() ? item.repo.trim() : undefined;
      if (repo && !REPO_PATTERN.test(repo)) throw new BotTaskError(400, "A commit's repo is owner/repo.");
      return { kind: "commit", sha: item.sha.trim().toLowerCase(), ...(repo ? { repo } : {}) };
    }
    case "ci_run": {
      const url = httpsUrl(item.url, "A CI run");
      return { kind: "ci_run", url: storedGithubUrl(url.toString()) };
    }
    case "review_url": {
      const url = httpsUrl(item.url, "A review or comment link");
      if (url.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/.test(url.pathname)) throw new BotTaskError(400, "A review or comment link points at a GitHub pull request or issue, https://github.com/<owner>/<repo>/pull/<n>#…");
      return { kind: "review_url", url: storedGithubUrl(url.toString()) };
    }
    case "command": {
      const command = typeof item.command === "string" ? item.command.trim() : "";
      if (!command || command.length > 500) throw new BotTaskError(400, `A command item names the command that ran (up to 500 characters). ${EVIDENCE_EXAMPLE}`);
      if (typeof item.exitCode !== "number" || !Number.isInteger(item.exitCode)) throw new BotTaskError(400, `A command item needs the integer exitCode it returned. ${EVIDENCE_EXAMPLE}`);
      return { kind: "command", command: redactSecretsInText(command).slice(0, 500), exitCode: item.exitCode };
    }
    default:
      throw new BotTaskError(400, `Evidence kind must be commit, ci_run, review_url or command. ${EVIDENCE_EXAMPLE}`);
  }
}

/** The one word the board shows for a task's evidence: the best check any item passed, else the worst it got. */
export function evidenceStatus(items: readonly BotTaskEvidence[] | undefined): BotTaskVerification["status"] | undefined {
  const states = (items ?? []).flatMap((item) => (item.verification ? [item.verification.status] : []));
  return (["verified", "failed", "unverifiable"] as const).find((status) => states.includes(status));
}

/** A command that failed does not show the work is done. */
export function supportsDone(items: readonly BotTaskEvidence[]): boolean {
  return items.some((item) => item.kind === "command" ? item.exitCode === 0 : item.verification?.status === "verified");
}

const ACTIONS = /^\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?\/?$/;
const DISCUSSION = /^\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)\/?$/;
const ANCHOR = /^#(pullrequestreview|discussion_r|issuecomment)-?(\d+)$/;

function reviewTarget(url: URL) {
  const discussion = DISCUSSION.exec(url.pathname);
  const anchor = ANCHOR.exec(url.hash);
  if (!discussion || !anchor || url.origin !== "https://github.com") return;
  const [, repo, kind, number] = discussion;
  const [, type, id] = anchor;
  if (type !== "issuecomment" && kind !== "pull") return;
  const route = type === "pullrequestreview" ? `pulls/${number}/reviews` : type === "discussion_r" ? "pulls/comments" : "issues/comments";
  return { repo: repo!, number: Number(number), type, id, route: `${route}/${id}` };
}

export async function verifyEvidence(
  claim: BotTaskEvidenceClaim,
  ref: BotTaskGithubRef | undefined,
  settings: Pick<BotTasksSettings, "repos">,
  lookup: GithubClient["lookupEvidence"] | undefined,
  checkedAt: number,
  loadPullCommits?: () => ReturnType<GithubClient["pullCommitEvidence"]>,
): Promise<BotTaskEvidence> {
  const result = (status: BotTaskVerification["status"], detail: string): BotTaskEvidence =>
    ({ ...claim, verification: { status, checkedAt, detail } });
  if (claim.kind === "command") return result("unverifiable", `Self-reported exit code ${claim.exitCode}, not independently checked.`);

  const repo = ref?.repo ?? (claim.kind === "commit" ? claim.repo : undefined);
  if (!repo || !REPO_PATTERN.test(repo) || !repoAllowed(settings, repo)) {
    return result("unverifiable", "Evidence needs an allowed GitHub repository.");
  }
  const base = `/repos/${repo}`;
  let path: string;
  let what: string;
  let review: ReturnType<typeof reviewTarget>;
  let jobRun: string | undefined;
  if (claim.kind === "commit") {
    if (claim.repo && claim.repo.toLowerCase() !== repo.toLowerCase()) return result("failed", "Commit repository does not match the linked repository.");
    path = `${base}/commits/${claim.sha}`;
    what = `commit ${claim.sha}`;
  } else if (claim.kind === "ci_run") {
    const url = new URL(claim.url);
    const run = ACTIONS.exec(url.pathname);
    if (url.origin !== "https://github.com" || run?.[1]?.toLowerCase() !== repo.toLowerCase()) {
      return result("failed", `CI evidence must be a GitHub Actions run or job in ${repo}.`);
    }
    path = run[3] ? `${base}/actions/jobs/${run[3]}` : `${base}/actions/runs/${run[2]}`;
    if (run[3]) jobRun = run[2];
    what = run[3] ? `CI job ${run[3]}` : `CI run ${run[2]}`;
  } else {
    review = reviewTarget(new URL(claim.url));
    if (review?.repo.toLowerCase() !== repo.toLowerCase() || review.number !== ref?.number) {
      return result("failed", "Review evidence must point to a review or comment on the linked GitHub item.");
    }
    path = `${base}/${review.route}`;
    what = `GitHub review or comment ${review.id}`;
  }

  if (!lookup) return result("unverifiable", `No GitHub credential is usable to check ${what}.`);
  try {
    const answer = await lookup(path);
    if (claim.kind === "commit") {
      const sha = answer.sha?.toLowerCase();
      if (!sha?.startsWith(claim.sha)) return result("unverifiable", `GitHub did not return the requested ${what} in ${repo}.`);
      if (ref) {
        if (!loadPullCommits) return result("unverifiable", `GitHub could not check ${what} against ${refLabel(ref)}.`);
        const pull = await loadPullCommits().catch(() => undefined);
        if (pull === undefined) return result("unverifiable", `GitHub could not check ${what} against ${refLabel(ref)}.`);
        if (pull?.shas.includes(sha)) return result("verified", `${what} is on pull request ${refLabel(ref)}.`);
        if (pull) return pull.complete
          ? result("failed", `${what} is not on pull request ${refLabel(ref)}.`)
          : result("unverifiable", `GitHub returned a limited commit list for ${refLabel(ref)}.`);
      }
    }
    if (claim.kind === "ci_run") {
      if (jobRun && String(answer.run_id) !== jobRun) return result("failed", `${what} does not belong to run ${jobRun}.`);
      if (answer.status !== "completed") return result("unverifiable", `${what} has not finished.`);
      if (answer.conclusion === "success") return result("verified", `${what} concluded with success.`);
      const conclusion = /^[a-z_]{1,40}$/.test(answer.conclusion ?? "") ? answer.conclusion : "unknown";
      return result("failed", `${what} concluded with ${conclusion}.`);
    }
    if (review) {
      const actual = answer.html_url ? reviewTarget(new URL(answer.html_url)) : undefined;
      if (actual?.repo.toLowerCase() !== review.repo.toLowerCase() || actual.number !== review.number ||
        actual.type !== review.type || actual.id !== review.id) {
        return result("failed", `${what} does not belong to the linked GitHub item.`);
      }
    }
    return result("verified", `${what} exists in ${repo}.`);
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) return result("failed", `${what} not found in ${repo}.`);
    if (error instanceof GithubError && error.status === 401) return result("unverifiable", `No GitHub credential is usable to check ${what}.`);
    return result("unverifiable", `GitHub could not confirm ${what} in ${repo}.`);
  }
}

const REF_TEXT = /(?<![\w/.-])([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#(\d{1,7})\b/g;
const REF_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/(pull|issues)\/(\d{1,7})\b/g;

/** Every distinct GitHub pull request or issue a text names, as owner/repo#n or as a github.com link. */
export function githubRefsIn(text: string): BotTaskGithubRef[] {
  const found = new Map<string, BotTaskGithubRef>();
  for (const match of text.matchAll(REF_URL)) found.set(`${match[1]!.toLowerCase()}#${match[3]}`, { repo: match[1]!, number: Number(match[3]), kind: match[2] === "pull" ? "pull" : "issue" });
  for (const match of text.matchAll(REF_TEXT)) if (!found.has(`${match[1]!.toLowerCase()}#${match[2]}`)) found.set(`${match[1]!.toLowerCase()}#${match[2]}`, { repo: match[1]!, number: Number(match[2]) });
  return [...found.values()];
}

export function parseRef(raw: unknown): BotTaskGithubRef {
  if (typeof raw !== "string") throw new BotTaskError(400, "A GitHub reference is owner/repo#number or a github.com pull request or issue link.");
  const refs = githubRefsIn(raw.trim());
  if (refs.length !== 1) throw new BotTaskError(400, "A GitHub reference is owner/repo#number or a github.com pull request or issue link.");
  return refs[0]!;
}

export const refLabel = (ref: BotTaskGithubRef) => `${ref.repo}#${ref.number}`;
