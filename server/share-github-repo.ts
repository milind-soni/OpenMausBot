// Template folders in a GitHub repository, read and written through a GitHub connection on the connected-apps service
// (the person's own, or the team's): from the server, with the token kept by the service and nothing passing through a
// model. Tool names, arguments and answer shapes follow Composio's GitHub toolkit documentation and are not yet checked
// against the live service, so an answer of any other shape is an error in words, never an empty folder.
// Security: owner, repository, ref and folder are plain path segments; only the files the manifest names are read, with
// the public reader's caps; a link shown back must be on github.com under the repository asked for.
import { randomBytes } from "node:crypto";

import { decodeBase64 } from "../shared/package-format.ts";
import { MANIFEST_NAMES, namedFolderFiles, readShareFolder, SHARE_FOLDER_MAX_BYTES, SHARE_FOLDER_MAX_FILES, type ShareFolder, type ShareFolderFiles } from "../shared/share-folder.ts";
import type { TemplateRepoPublish } from "../shared/share-card.ts";
import { toolData } from "./connected-reads.ts";
import { parseMcpResponse } from "./connector-tools-list.ts";
import { GithubTemplateError } from "./share-github.ts";

export const GITHUB_TOOLS = {
  repository: "GITHUB_GET_A_REPOSITORY",
  content: "GITHUB_GET_REPOSITORY_CONTENT",
  branch: "GITHUB_GET_A_BRANCH",
  blob: "GITHUB_CREATE_A_BLOB",
  tree: "GITHUB_CREATE_A_TREE",
  commit: "GITHUB_CREATE_A_COMMIT",
  createRef: "GITHUB_CREATE_A_REFERENCE",
  updateRef: "GITHUB_UPDATE_A_REFERENCE",
  pullRequest: "GITHUB_CREATE_A_PULL_REQUEST",
} as const;

export type GithubRelay = (payload: unknown, transportSessionId: string | undefined, signal: AbortSignal) =>
  Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;

/** A GitHub connection a request may use: the relay to its account, or why there is none. */
export type GithubConnection =
  | { ok: true; relay: GithubRelay; account?: string }
  | { ok: false; reason: "not_connected" | "refused" | "unavailable"; message: string };

export const CONNECT_GITHUB = "Connect GitHub in Apps first.";
const MANIFEST_MAX_BYTES = 1_000_000;
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CALL_ID = "omb-share-github";
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const NOT_THERE = /\b(?:not found|404|no commit found|does not exist)\b/i;
const MISSING = Symbol("missing");

export interface RepoFolder {
  owner: string;
  repo: string;
  /** Absent: the repository's default branch. */
  ref?: string;
  /** "/"-separated, "" for the repository's root. */
  path: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** A field of a tool's data, which the service may wrap once more. */
function field(data: unknown, name: string): unknown {
  for (const body of [record(data), record(record(data)?.details), record(record(data)?.response_data), record(record(data)?.data)]) {
    if (body && name in body) return body[name];
  }
  return undefined;
}
const text = (data: unknown, name: string): string | undefined => {
  const value = field(data, name);
  return typeof value === "string" && value ? value : undefined;
};

export function repoName(value: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "").split("/");
  if (rest.length || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** A folder inside a repository, "" for its root; null when a part isn't a plain name. */
export function repoFolder(value: string | undefined): string | null {
  const parts = (value ?? "").trim().split("/").filter(Boolean);
  return parts.length <= 6 && parts.every((part) => SEGMENT.test(part)) ? parts.join("/") : null;
}

/** Where a github.com link's template lives: a repository, a folder (tree), or a bot.md or team.md in one (blob). */
export function repoFolderOf(link: string): RepoFolder | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com") || url.username || url.password || url.port) return null;
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const [owner, repo, kind, ref, ...path] = parts;
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || !path.every((part) => SEGMENT.test(part))) return null;
  if (!kind) return { owner, repo, path: "" };
  if (!ref || !SEGMENT.test(ref)) return null;
  if (kind === "tree") return { owner, repo, ref, path: path.join("/") };
  if (kind === "blob" && (path.at(-1) === MANIFEST_NAMES.bot || path.at(-1) === MANIFEST_NAMES.department)) return { owner, repo, ref, path: path.slice(0, -1).join("/") };
  return null;
}

/** One connection's GitHub calls, over one connected-apps session. */
export function githubSession(connection: Extract<GithubConnection, { ok: true }>, timeoutMs = 60_000) {
  let opened: Promise<string | undefined> | undefined;
  const open = async (signal: AbortSignal) => {
    const init = await connection.relay({
      jsonrpc: "2.0", id: "omb-share-init", method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-templates", version: "1" } },
    }, undefined, signal);
    if (init.status !== 200) throw new GithubTemplateError(`GitHub couldn't be reached through Apps (HTTP ${init.status}). Try again in a few minutes.`, 502);
    await connection.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, init.transportSessionId, signal).catch(() => undefined);
    return init.transportSessionId;
  };
  /** The tool's data; `missing` (instead of an error) when GitHub says the thing asked for isn't there. */
  async function call(slug: string, args: Record<string, unknown>): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      opened ??= open(signal).catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
      const transport = await opened;
      const answer = await connection.relay({
        jsonrpc: "2.0", id: CALL_ID, method: "tools/call",
        params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: slug, arguments: args, ...(connection.account ? { account: connection.account } : {}) }] } },
      }, transport, signal);
      if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
      return toolData(slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), CALL_ID));
    } catch (error) {
      if (error instanceof GithubTemplateError) throw error;
      const words = error instanceof Error ? error.message : String(error);
      if (NOT_THERE.test(words)) return MISSING;
      if (/came back shortened/.test(words)) throw new GithubTemplateError("A file there is too large to read through Apps.", 413);
      if (signal.aborted) throw new GithubTemplateError("GitHub didn't answer in time. Try again in a few minutes.", 504);
      throw new GithubTemplateError(`GitHub refused: ${words.slice(0, 200)}`, 502);
    }
  }
  return { call, missing: MISSING as unknown };
}
type Session = ReturnType<typeof githubSession>;

async function defaultBranch(session: Session, owner: string, repo: string): Promise<{ branch: string; push?: boolean }> {
  const data = await session.call(GITHUB_TOOLS.repository, { owner, repo });
  if (data === session.missing) throw new GithubTemplateError(`${owner}/${repo} wasn't found, or your GitHub connection can't see it.`, 404);
  const branch = text(data, "default_branch");
  if (!branch) throw new GithubTemplateError("GitHub's answer about the repository had no default branch.", 502);
  const push = record(field(data, "permissions"))?.push;
  return { branch, ...(typeof push === "boolean" ? { push } : {}) };
}

/** A file's bytes, null when it isn't there. */
async function fileBytes(session: Session, at: RepoFolder & { ref: string }, path: string, maxBytes: number): Promise<Uint8Array | null> {
  const data = await session.call(GITHUB_TOOLS.content, { owner: at.owner, repo: at.repo, path: [at.path, path].filter(Boolean).join("/"), ref: at.ref });
  if (data === session.missing) return null;
  if (Array.isArray(data) || field(data, "type") === "dir") throw new GithubTemplateError(`${path} is a folder in that repository, not a file.`);
  const size = field(data, "size");
  if (typeof size === "number" && size > maxBytes) throw new GithubTemplateError("This template is larger than 4 MB.", 413);
  const content = field(data, "content");
  if (typeof content !== "string") throw new GithubTemplateError(`GitHub's answer for ${path} had no content. A file over 1 MB can't be read this way.`, 502);
  const bytes = field(data, "encoding") === "base64" ? decodeBase64(content.replace(/\s+/g, "")) : new TextEncoder().encode(content);
  if (!bytes) throw new GithubTemplateError(`GitHub's answer for ${path} couldn't be read.`, 502);
  if (bytes.byteLength > maxBytes) throw new GithubTemplateError("This template is larger than 4 MB.", 413);
  return bytes;
}

/** The template folder at `at`, through the connection, with the public reader's caps; nothing is added. */
export async function readRepoFolder(connection: Extract<GithubConnection, { ok: true }>, at: RepoFolder): Promise<ShareFolder> {
  const session = githubSession(connection);
  const ref = at.ref ?? (await defaultBranch(session, at.owner, at.repo)).branch;
  const where = { ...at, ref };
  for (const name of [MANIFEST_NAMES.bot, MANIFEST_NAMES.department]) {
    const manifest = await fileBytes(session, where, name, MANIFEST_MAX_BYTES);
    if (!manifest) continue;
    const manifestText = new TextDecoder().decode(manifest);
    const files: ShareFolderFiles = { [name]: manifestText };
    let total = manifest.byteLength;
    const named = namedFolderFiles(manifestText);
    if (named.length + 1 > SHARE_FOLDER_MAX_FILES) throw new GithubTemplateError("This folder has too many files to be a template.");
    for (const path of named) {
      const body = await fileBytes(session, where, path, SHARE_FOLDER_MAX_BYTES - total);
      if (!body) continue;
      total += body.byteLength;
      files[path] = path.startsWith("avatars/") ? body : new TextDecoder().decode(body);
    }
    return readShareFolder(files);
  }
  throw new GithubTemplateError("No bot.md or team.md was found in that folder.", 404);
}

const toBase64 = (value: string | Uint8Array) => Buffer.from(typeof value === "string" ? new TextEncoder().encode(value) : value).toString("base64");

/** Security: a link GitHub answers with is shown only when it is on github.com under the repository asked for. */
function inRepository(value: unknown, owner: string, repo: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const prefix = `/${owner}/${repo}/`.toLowerCase();
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.toLowerCase().startsWith(prefix) ? url.href : null;
  } catch {
    return null;
  }
}

/** Commits the folder as <folder>/<slug> in one commit: on a new branch with a pull request, or straight on the
 * default branch. Files already there under other names stay. */
export async function publishToRepo(connection: Extract<GithubConnection, { ok: true }>, input: {
  owner: string; repo: string; folder: string; slug: string; name: string; files: Record<string, string | Uint8Array>; direct: boolean;
}): Promise<TemplateRepoPublish> {
  const session = githubSession(connection);
  const { owner, repo } = input;
  const { branch: base, push } = await defaultBranch(session, owner, repo);
  if (push === false) throw new GithubTemplateError(`Your GitHub connection can't write to ${owner}/${repo}.`, 403);
  const head = await session.call(GITHUB_TOOLS.branch, { owner, repo, branch: base });
  const headCommit = record(field(head, "commit"));
  const headSha = typeof headCommit?.sha === "string" ? headCommit.sha : undefined;
  const baseTree = record(record(headCommit?.commit)?.tree)?.sha;
  if (!headSha || typeof baseTree !== "string") throw new GithubTemplateError(`GitHub's answer about ${base} had no commit.`, 502);
  const dir = [input.folder, input.slug].filter(Boolean).join("/");
  const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const [path, value] of Object.entries(input.files)) {
    const blob = await session.call(GITHUB_TOOLS.blob, { owner, repo, content: toBase64(value), encoding: "base64" });
    const sha = text(blob, "sha");
    if (!sha) throw new GithubTemplateError("GitHub's answer for a file had no id.", 502);
    tree.push({ path: `${dir}/${path}`, mode: "100644", type: "blob", sha });
  }
  const madeTree = text(await session.call(GITHUB_TOOLS.tree, { owner, repo, base_tree: baseTree, tree }), "sha");
  if (!madeTree) throw new GithubTemplateError("GitHub's answer for the folder had no id.", 502);
  const message = `Add the ${input.name} template from MausBot`;
  const commit = text(await session.call(GITHUB_TOOLS.commit, { owner, repo, message, tree: madeTree, parents: [headSha] }), "sha");
  if (!commit) throw new GithubTemplateError("GitHub's answer for the commit had no id.", 502);
  const link = (branch: string) => `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}/${dir}`;
  if (input.direct) {
    const moved = await session.call(GITHUB_TOOLS.updateRef, { owner, repo, ref: `heads/${base}`, sha: commit, force: false });
    if (moved === session.missing) throw new GithubTemplateError(`${base} couldn't be updated. Try a pull request instead.`, 409);
    return { kind: "commit", url: link(base), link: link(base), branch: base };
  }
  const branch = `mausbot-${input.slug}-${randomBytes(3).toString("hex")}`;
  const made = await session.call(GITHUB_TOOLS.createRef, { owner, repo, ref: `refs/heads/${branch}`, sha: commit });
  if (made === session.missing) throw new GithubTemplateError("The new branch couldn't be made.", 502);
  const pull = await session.call(GITHUB_TOOLS.pullRequest, {
    owner, repo, title: message, head: branch, base,
    body: "A template made in MausBot: its instructions, skills and their scripts, and pictures. No chats, memory, keys or connections.",
  });
  const url = inRepository(field(pull, "html_url"), owner, repo);
  if (!url) throw new GithubTemplateError("GitHub's answer for the pull request had no link.", 502);
  return { kind: "pull_request", url, link: link(branch), branch };
}
