/**
 * Which Origin issues a pull request or commit refers to, read from text people (and agents) already write:
 * the branch name, the PR title, and closing keywords in the PR body or commit message.
 *
 * - `ORI-ABCD` in the branch name or PR title links and closes on merge (Linear's convention).
 * - `Closes ORI-ABCD`, `Fixes #12`, `Resolves <origin issue url>` in a body or commit message close on merge.
 * - `Refs ORI-ABCD`, `Part of #12` and bare mentions in a body only link.
 *
 * `#12` refers to the GitHub issue of the same repository, which resolves to the Origin issue linked to it.
 */

export const ISSUE_KEY_PREFIX = "ORI";
export const issueKey = (id: string) => `${ISSUE_KEY_PREFIX}-${id.slice(-4).toUpperCase()}`;

export type IssueReference =
  | { kind: "key"; key: string; closes: boolean }
  | { kind: "number"; number: number; closes: boolean }
  | { kind: "id"; id: string; closes: boolean };

const CLOSING = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|complete|completes|completed";
const LINKING = "ref|refs|references|part of|related to|relates to|towards|contributes to";
const KEY = String.raw`\bORI-([0-9A-Z]{4})\b`;
const NUMBER = String.raw`(?<![\w/])#(\d{1,9})\b`;
// An Origin issue link: `...?project=<id>&issue=<id>`; only the issue id matters.
const URL = String.raw`https?:\/\/[^\s)>\]]+?[?&]issue=([a-z0-9]{16,40})\b`;
const TARGET = `(?:${KEY}|${NUMBER}|${URL})`;
// `Closes ORI-ABCD, ORI-EFGH and #3`: a keyword applies to a comma/and-separated list after it.
const LIST = `${TARGET}(?:\\s*(?:,|and|&)\\s*${TARGET})*`;

function targets(text: string, closes: boolean, into: IssueReference[]) {
  for (const match of text.matchAll(new RegExp(TARGET, "gi"))) {
    if (match[1]) into.push({ kind: "key", key: `${ISSUE_KEY_PREFIX}-${match[1].toUpperCase()}`, closes });
    else if (match[2]) into.push({ kind: "number", number: Number(match[2]), closes });
    else if (match[3]) into.push({ kind: "id", id: match[3].toLowerCase(), closes });
  }
}

/** References in free text (a PR body or commit message). Only keyword-prefixed ones close. */
export function textReferences(text: string): IssueReference[] {
  const found: IssueReference[] = [];
  const bounded = text.slice(0, 20000);
  const keyword = new RegExp(`\\b(${CLOSING}|${LINKING})\\b:?\\s*(${LIST})`, "gi");
  let rest = bounded;
  for (const match of bounded.matchAll(keyword)) {
    targets(match[2], new RegExp(`^(?:${CLOSING})$`, "i").test(match[1]), found);
    rest = rest.replace(match[0], " ");
  }
  // Bare mentions of an issue key or Origin link (not `#12`, which is too common to mean an Origin issue) only link.
  for (const match of rest.matchAll(new RegExp(`${KEY}|${URL}`, "gi"))) {
    if (match[1]) found.push({ kind: "key", key: `${ISSUE_KEY_PREFIX}-${match[1].toUpperCase()}`, closes: false });
    else if (match[2]) found.push({ kind: "id", id: match[2].toLowerCase(), closes: false });
  }
  return found;
}

/** References of a pull request: an issue key in the branch or title closes; the body follows {@link textReferences}. */
export function pullRequestReferences(pr: { title?: string | null; body?: string | null; branch?: string | null }): IssueReference[] {
  const found: IssueReference[] = [];
  for (const source of [pr.branch ?? "", pr.title ?? ""]) {
    for (const match of source.slice(0, 1000).matchAll(new RegExp(KEY, "gi"))) found.push({ kind: "key", key: `${ISSUE_KEY_PREFIX}-${match[1].toUpperCase()}`, closes: true });
  }
  found.push(...textReferences(pr.body ?? ""));
  if (pr.title) for (const reference of textReferences(pr.title)) if (reference.kind !== "key") found.push(reference);
  return mergeReferences(found);
}

/** One entry per target; a target closes when any mention of it closes. */
export function mergeReferences(references: IssueReference[]): IssueReference[] {
  const byTarget = new Map<string, IssueReference>();
  for (const reference of references) {
    const id = reference.kind === "key" ? `key:${reference.key}` : reference.kind === "number" ? `number:${reference.number}` : `id:${reference.id}`;
    const previous = byTarget.get(id);
    byTarget.set(id, previous ? { ...previous, closes: previous.closes || reference.closes } : reference);
  }
  return [...byTarget.values()].slice(0, 50);
}
