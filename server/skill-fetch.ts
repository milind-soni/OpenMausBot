import { createHash } from "node:crypto";
import { z } from "zod";

import type { GitHubSkillOrigin, SkippedSkillFile } from "../shared/skill-import.ts";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { planSkillFolder, SKILL_FOLDER_LIMITS, type FolderEntry, type SkillFolderFile } from "./skill-folder.ts";

const API = "https://api.github.com";
const RAW_HOST = "raw.githubusercontent.com";
const USER_AGENT = "OpenMausBot-skills";
const LISTING_MAX_BYTES = 1_048_576;
// GitHub allows 60 API requests an hour without sign-in; downloads from the raw host are not counted against it.
const IMPORT_LIMITS = { apiRequests: 128, downloads: 1_000, bytes: 64 * 1_048_576, ms: 120_000 };
const PARALLEL_DOWNLOADS = 4;
class ImportLimitError extends Error {}
class GitHubApiError extends Error {}

// One budget for the whole import, enforced while reading the stream.
function boundedImportFetch(fetcher: typeof fetch): typeof fetch {
  let apiRequests = 0;
  let downloads = 0;
  let bytes = 0;
  const signal = AbortSignal.timeout(IMPORT_LIMITS.ms);
  return async (input, init) => {
    const listing = String(input).startsWith(`${API}/`);
    if (listing ? ++apiRequests > IMPORT_LIMITS.apiRequests : ++downloads > IMPORT_LIMITS.downloads) {
      throw new ImportLimitError("Import request limit reached — paste a specific skill folder instead.");
    }
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response;
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        bytes += chunk.value.byteLength;
        if (size > (listing ? LISTING_MAX_BYTES : SKILL_FOLDER_LIMITS.fileBytes) || bytes > IMPORT_LIMITS.bytes) {
          throw new ImportLimitError("Import size limit reached — paste a smaller skill folder instead.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
}

export interface FetchedSkill {
  source: string;
  /** Absent when GitHub would not list the folder and only SKILL.md came in. */
  github?: GitHubSkillOrigin;
  files: Array<SkillFolderFile & { content: Buffer; executable: boolean }>;
  skipped: SkippedSkillFile[];
}

interface Target {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  skill?: string;
  /** A link straight to a SKILL.md: what still comes in when GitHub will not list its folder. */
  rawUrl?: string;
}

const OWNER_OR_REPO = /^[\w.-]+$/;

/** Null for a path that does not decode, or would climb out of where it is used once decoded. */
function decodedPath(path: string): string | null {
  try {
    const decoded = path.split("/").filter(Boolean).map(decodeURIComponent).join("/");
    return decoded.split("/").some((part) => part === "." || part === "..") ? null : decoded;
  } catch {
    return null;
  }
}

function target(owner: string, repo: string, ref: string | undefined, path: string, extra: Partial<Target> = {}): Target | { error: string } {
  try { ref = ref === undefined ? undefined : decodeURIComponent(ref); }
  catch { return { error: "that does not look like a GitHub or skills.sh repository, folder, or SKILL.md URL" }; }
  const decoded = decodedPath(path);
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo) || [owner, repo].some((part) => /^\.+$/.test(part)) || decoded === null ||
    (ref !== undefined && (!ref || ref === "." || ref === ".." || /[\s?#]/.test(ref)))) {
    return { error: "that does not look like a GitHub or skills.sh repository, folder, or SKILL.md URL" };
  }
  return { owner, repo, ...(ref ? { ref } : {}), path: decoded, ...extra };
}

export function parseSkillSource(input: string): Target | { error: string } {
  const text = input.trim();
  if (!text) return { error: "paste a GitHub repository, folder, or SKILL.md URL" };
  const raw = text.match(/^(https?):\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+\/)?SKILL\.md$/i);
  if (raw) {
    // Plain http sends the skill URL in the clear; refuse it rather than upgrade it.
    if (raw[1]!.toLowerCase() !== "https") return { error: "paste an https:// raw.githubusercontent.com link instead of plain http" };
    const parts = (raw[4] ?? "").split("/").filter(Boolean);
    const named = parts[0] === "refs" && (parts[1] === "heads" || parts[1] === "tags") ? 3 : 1;
    if (parts.length < named) return { error: "that does not look like a GitHub or skills.sh repository, folder, or SKILL.md URL" };
    return target(raw[2]!, raw[3]!, parts[named - 1], parts.slice(named).join("/"), { rawUrl: text });
  }
  const github = text.replace(/[?#].*$/, "");
  const blob = github.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/((?:.*\/)?)SKILL\.md$/i);
  if (blob) {
    return target(blob[1]!, blob[2]!, blob[3]!, blob[4]!, {
      rawUrl: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}SKILL.md`,
    });
  }
  const tree = github.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (tree) return target(tree[1]!, tree[2]!, tree[3], tree[4] ?? "");
  const registry = text.match(/^https?:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)(?:\/([\w.-]+))?\/?$/i);
  if (registry) {
    if ([registry[1], registry[2]].some((part) => part === "." || part === "..") ||
      (registry[3] && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(registry[3]))) {
      return { error: "that does not look like a skills.sh repository or skill URL" };
    }
    // skills.sh pages install from github.com/<owner>/<repo>, filtered to the named skill.
    return { owner: registry[1]!, repo: registry[2]!, path: "", skill: registry[3] };
  }
  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return target(shorthand[1]!, shorthand[2]!, undefined, "");
  return { error: "that does not look like a GitHub or skills.sh repository, folder, or SKILL.md URL" };
}

const CONTENT_ENTRY = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  sha: z.string().optional(),
  download_url: z.string().nullable().optional(),
});
type ContentEntry = z.infer<typeof CONTENT_ENTRY>;

const CONTENT_LISTING = z.array(z.unknown()).catch([]);

function asEntries(listing: z.infer<typeof CONTENT_LISTING>): ContentEntry[] {
  return listing.flatMap((item) => {
    const entry = CONTENT_ENTRY.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

function encodePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  // Security: a URL parser resolves dot segments, which would aim the request at another endpoint of the host.
  if (parts.some((part) => part === "." || part === "..")) throw new Error(`refusing the path ${JSON.stringify(path)}`);
  return parts.map(encodeURIComponent).join("/");
}

function apiError(response: Response, url: string): GitHubApiError {
  const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  return new GitHubApiError(limited
    ? "GitHub's limit for requests without sign-in was reached — try again within the hour"
    : `GitHub API ${response.status} for ${url}`);
}

async function apiGet(url: string, fetcher: typeof fetch, accept = "application/vnd.github+json"): Promise<Response> {
  const response = await fetcher(url, { headers: { accept, "user-agent": USER_AGENT } });
  if (!response.ok) throw apiError(response, url);
  return response;
}

/** The commit `ref` names now; HEAD is the default branch. */
async function resolveCommit(owner: string, repo: string, ref: string, fetcher: typeof fetch): Promise<string> {
  const url = `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const sha = (await (await apiGet(url, fetcher, "application/vnd.github.sha")).text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubApiError(`GitHub did not name a commit for ${url}`);
  return sha;
}

/** A repository read at one commit; `trees` holds the folder hashes its listings named. */
interface Snapshot {
  owner: string;
  repo: string;
  commit: string;
  trees: Map<string, string>;
}

async function listDir(snapshot: Snapshot, path: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const url = `${API}/repos/${snapshot.owner}/${snapshot.repo}/contents/${encodePath(path)}?ref=${snapshot.commit}`;
  const entries = asEntries(CONTENT_LISTING.parse(await (await apiGet(url, fetcher)).json()));
  for (const entry of entries) if (entry.type === "dir" && entry.sha) snapshot.trees.set(entry.path, entry.sha);
  return entries;
}

// Pin download_urls and pasted raw URLs to https on the raw host, no port or credentials, so a tampered response cannot aim server fetches elsewhere.
function assertPinnedRawUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing to download ${url} — not a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hostname !== RAW_HOST) {
    throw new Error(`refusing to download ${url} — skill files must be https://raw.githubusercontent.com links`);
  }
}

async function fetchBytes(url: string, fetcher: typeof fetch): Promise<Buffer> {
  assertPinnedRawUrl(url);
  // The raw host never redirects: error rather than follow one to an arbitrary host.
  const response = await fetcher(url, { headers: { "user-agent": USER_AGENT }, redirect: "error" });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export const MAX_SKILLS_PER_IMPORT = 30;
const MAX_FOLDERS_WALKED = 24;
const MAX_CHILDREN_PER_FOLDER = 60;

const passThrough = (error: unknown) => error instanceof ImportLimitError || (error instanceof Error && error.name === "TimeoutError");

/** Mirrors skills.sh's toSkillSlug: page slugs come from SKILL.md names, which can differ from folder names. */
const toSkillSlug = (name: string) =>
  name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

async function skillNameFrom(entries: ContentEntry[], fetcher: typeof fetch): Promise<string | undefined> {
  const skillMd = entries.find((entry) => entry.type === "file" && entry.name === "SKILL.md" && entry.download_url);
  if (!skillMd) return undefined;
  try {
    const text = (await fetchBytes(skillMd.download_url!, fetcher)).toString("utf8");
    return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  } catch (error) {
    if (passThrough(error)) throw error;
    return undefined;
  }
}

/** The skills.sh registry's discovery order: the path, skills/, .claude/skills/, .agents/skills/, then direct children. */
async function discoverSkillDirs(target: Target, snapshot: Snapshot, fetcher: typeof fetch): Promise<string[]> {
  const root = await listDir(snapshot, target.path, fetcher);
  const wanted = target.skill ? toSkillSlug(target.skill) || undefined : undefined;
  const dirMatches = (dir: string) => !!wanted && toSkillSlug(dir.split("/").at(-1)!) === wanted;
  const isWanted = async (dir: string, entries: ContentEntry[]) => {
    if (!wanted) return true;
    if (dirMatches(dir)) return true;
    const name = await skillNameFrom(entries, fetcher);
    return !!name && toSkillSlug(name) === wanted;
  };
  if (root.some((entry) => entry.type === "file" && entry.name === "SKILL.md") && (await isWanted(target.path, root))) {
    return [target.path];
  }
  const dirs = root.filter((entry) => entry.type === "dir");
  const found: string[] = [];
  const preferred = ["skills", ".claude", ".agents"];
  const rank = (name: string) => (wanted && toSkillSlug(name) === wanted ? 0 : preferred.includes(name) ? 1 : 2);
  const ordered = [...dirs].sort((a, b) => rank(a.name) - rank(b.name));
  const enough = () => found.length >= (wanted ? 1 : MAX_SKILLS_PER_IMPORT);
  for (const dir of ordered.slice(0, MAX_FOLDERS_WALKED)) {
    if (enough()) break;
    const base = dir.name === ".claude" || dir.name === ".agents" ? `${dir.path}/skills` : dir.path;
    let children: ContentEntry[];
    try {
      children = await listDir(snapshot, base, fetcher);
    } catch (error) {
      if (passThrough(error)) throw error;
      continue;
    }
    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      if (await isWanted(base, children)) found.push(base);
      continue;
    }
    const childDirs = children.filter((entry) => entry.type === "dir");
    const exact = wanted ? childDirs.find((child) => dirMatches(child.path)) : undefined;
    const candidates = exact
      ? [exact, ...childDirs.filter((child) => child !== exact).slice(0, MAX_CHILDREN_PER_FOLDER - 1)]
      : childDirs.slice(0, MAX_CHILDREN_PER_FOLDER);
    for (const child of candidates) {
      if (enough()) break;
      try {
        const inner = await listDir(snapshot, child.path, fetcher);
        if (inner.some((entry) => entry.type === "file" && entry.name === "SKILL.md") && (await isWanted(child.path, inner))) found.push(child.path);
      } catch (error) {
        if (passThrough(error)) throw error;
      }
    }
  }
  return found;
}

const TREE = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() })),
});

/** Every entry below `dir` at the snapshot's commit, in one request however deep the folder goes. */
async function folderTree(snapshot: Snapshot, dir: string, fetcher: typeof fetch): Promise<Array<FolderEntry & { sha: string }>> {
  if (dir && !snapshot.trees.has(dir)) await listDir(snapshot, dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "", fetcher);
  const sha = dir ? snapshot.trees.get(dir) : snapshot.commit;
  if (!sha) throw new GitHubApiError(`GitHub did not list the folder ${dir}`);
  const url = `${API}/repos/${snapshot.owner}/${snapshot.repo}/git/trees/${sha}?recursive=1`;
  const listing = TREE.safeParse(await (await apiGet(url, fetcher)).json());
  if (!listing.success) throw new GitHubApiError(`GitHub sent an unreadable folder listing for ${url}`);
  if (listing.data.truncated) throw new ImportLimitError("That skill folder holds too many files to list — paste a smaller folder instead.");
  return listing.data.tree.map((entry) => ({
    path: entry.path,
    sha: entry.sha,
    size: entry.size ?? 0,
    kind: entry.type === "tree" ? "folder" : entry.type === "commit" ? "submodule" : entry.mode === "120000" ? "link" : "file",
    executable: entry.mode === "100755",
  }));
}

const gitBlobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const isLfsPointer = (bytes: Buffer) => bytes.length < 1024 && bytes.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n");

async function fetchSkillFolder(target: Target, snapshot: Snapshot, dir: string, fetcher: typeof fetch): Promise<FetchedSkill> {
  const entries = await folderTree(snapshot, dir, fetcher);
  const { take, skipped } = planSkillFolder(entries);
  if (take[0]?.path !== "SKILL.md") throw new Error(`no SKILL.md in ${dir || "the repository root"}`);
  if (take[0].size > SKILL_FILE_MAX_BYTES) throw new Error(`SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB`);
  const files: FetchedSkill["files"] = [];
  for (let i = 0; i < take.length; i += PARALLEL_DOWNLOADS) {
    const batch = await Promise.all(take.slice(i, i + PARALLEL_DOWNLOADS).map(async (entry) => {
      const location = encodePath(dir ? `${dir}/${entry.path}` : entry.path);
      const content = await fetchBytes(`https://${RAW_HOST}/${snapshot.owner}/${snapshot.repo}/${snapshot.commit}/${location}`, fetcher);
      // Security: every file is the one the commit's tree names, so the recorded commit is what came in.
      if (gitBlobSha(content) !== entry.sha) throw new Error(`${entry.path} does not match commit ${snapshot.commit.slice(0, 7)} — try the import again`);
      return { path: entry.path, content, executable: Boolean(entry.executable) };
    }));
    for (const file of batch) {
      if (file.path !== "SKILL.md" && isLfsPointer(file.content)) skipped.push({ path: file.path, reason: "lfs" });
      else files.push(file);
    }
  }
  const ref = target.ref ? `@${target.ref}` : "";
  return {
    source: `github.com/${snapshot.owner}/${snapshot.repo}${ref}/${dir}`.replace(/\/$/, ""),
    github: { owner: snapshot.owner, repo: snapshot.repo, ref: target.ref ?? "HEAD", commit: snapshot.commit, path: dir },
    files,
    skipped,
  };
}

async function fetchSkills(target: Target, fetcher: typeof fetch): Promise<FetchedSkill[]> {
  const commit = await resolveCommit(target.owner, target.repo, target.ref ?? "HEAD", fetcher);
  const snapshot: Snapshot = { owner: target.owner, repo: target.repo, commit, trees: new Map() };
  const dirs = await discoverSkillDirs(target, snapshot, fetcher);
  if (!dirs.length) {
    throw new Error(target.skill
      ? `no skill named "${target.skill}" found there — check the exact name on the skills.sh page`
      : "no SKILL.md found there — paste a skill folder or a repo with a skills/ directory");
  }
  const skills: FetchedSkill[] = [];
  for (const dir of dirs) skills.push(await fetchSkillFolder(target, snapshot, dir, fetcher));
  return skills;
}

export async function fetchSkillFromSource(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<{ skills: FetchedSkill[] } | { error: string }> {
  const parsed = parseSkillSource(input);
  if ("error" in parsed) return parsed;
  fetcher = boundedImportFetch(fetcher);
  try {
    return { skills: await fetchSkills(parsed, fetcher) };
  } catch (error) {
    if (parsed.rawUrl && error instanceof GitHubApiError) {
      try {
        const content = await fetchBytes(parsed.rawUrl, fetcher);
        return { skills: [{ source: parsed.rawUrl, files: [{ path: "SKILL.md", content, executable: false }], skipped: [{ path: "", reason: "unlisted" }] }] };
      } catch {}
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The commit a GitHub skill's link names now: newer than `origin.commit` means an update is available. */
export async function latestSkillCommit(origin: GitHubSkillOrigin, fetcher: typeof fetch = fetch): Promise<string | { error: string }> {
  try {
    return await resolveCommit(origin.owner, origin.repo, origin.ref, boundedImportFetch(fetcher));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The link that imports the same folder again, at whatever commit its ref names by then. */
export const githubSkillLink = (origin: GitHubSkillOrigin): string =>
  `https://github.com/${origin.owner}/${origin.repo}/tree/${encodeURIComponent(origin.ref)}${origin.path ? `/${encodePath(origin.path)}` : ""}`;
