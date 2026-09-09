// Fetch a skill's files from where users actually keep skills: a GitHub
// repo, a folder inside one, or a direct SKILL.md. Network in, plain
// {path, content} list out — validation, scanning, and storage live in
// skills.ts, so this file owns exactly one concern and its tests can hand
// it a fake fetch.
//
// Caps mirror the skills.sh CLI's: nothing here downloads more than
// MAX_FILES files or MAX_FILE_BYTES per file, and only markdown is ever
// requested (v1 imports are markdown-only by policy).
import { z } from "zod";

const MAX_FILES = 30;
const MAX_FILE_BYTES = 256 * 1024;
const API = "https://api.github.com";
class ImportLimitError extends Error {}

// One budget for the entire import, including directory discovery. Read the
// stream within the cap rather than allocating an unbounded response first.
function boundedImportFetch(fetcher: typeof fetch): typeof fetch {
  let requests = 0;
  let bytes = 0;
  const signal = AbortSignal.timeout(60_000);
  return async (input, init) => {
    if (++requests > 128) throw new ImportLimitError("Import request limit reached — paste a specific skill folder instead.");
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response;
    }
    if (!response.body) return response;
    const listing = String(input).startsWith(`${API}/`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        bytes += chunk.value.byteLength;
        if (size > (listing ? 1_048_576 : MAX_FILE_BYTES) || bytes > 8 * 1_048_576) {
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
  files: Array<{ path: string; content: string }>;
}

interface Target {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

/** owner/repo, github.com/owner/repo[/tree/<ref>/<path>], or a raw/blob URL
 * straight to a SKILL.md. Anything else is refused, loudly. */
export function parseSkillSource(input: string): Target | { rawUrl: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "paste a GitHub repository, folder, or SKILL.md URL" };
  if (/^https?:\/\/raw\.githubusercontent\.com\/.+\/SKILL\.md$/i.test(text)) return { rawUrl: text };
  const blob = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+SKILL\.md)$/i);
  if (blob) {
    return { rawUrl: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}` };
  }
  const tree = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (tree) {
    return { owner: tree[1]!, repo: tree[2]!, ref: tree[3], path: tree[4] ?? "" };
  }
  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, path: "" };
  return { error: "that does not look like a GitHub repository, folder, or SKILL.md URL" };
}

const CONTENT_ENTRY = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  download_url: z.string().nullable().optional(),
});
type ContentEntry = z.infer<typeof CONTENT_ENTRY>;

// The GitHub contents API is the I/O boundary: parse its JSON here, keep
// only entries matching the documented shape, drop the rest silently.
const CONTENT_LISTING = z.array(z.unknown()).catch([]);

function asEntries(listing: z.infer<typeof CONTENT_LISTING>): ContentEntry[] {
  return listing.flatMap((item) => {
    const entry = CONTENT_ENTRY.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

async function fetchListing(url: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const response = await fetcher(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "OpenMausBot-skills" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return asEntries(CONTENT_LISTING.parse(await response.json()));
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { headers: { "user-agent": "OpenMausBot-skills" } });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("file is larger than the 256KB import cap");
  return text;
}

async function listDir(target: Target, path: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : "";
  const url = `${API}/repos/${target.owner}/${target.repo}/contents/${path}${ref}`;
  return fetchListing(url, fetcher);
}

export const MAX_SKILLS_PER_IMPORT = 30;
const MAX_FOLDERS_WALKED = 24;
const MAX_CHILDREN_PER_FOLDER = 60;

/** Where SKILL.md folders live in real repos, per the registry's own
 * discovery order: the pasted path itself, then skills/, then .claude/skills/
 * and .agents/skills/, then one level of direct children. */
export async function discoverSkillDirs(target: Target, fetcher: typeof fetch): Promise<string[]> {
  const root = await listDir(target, target.path, fetcher);
  if (root.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
    return [target.path];
  }
  const dirs = root.filter((entry) => entry.type === "dir");
  const found: string[] = [];
  const preferred = ["skills", ".claude", ".agents"];
  const ordered = [...dirs].sort(
    (a, b) => (preferred.includes(a.name) ? 0 : 1) - (preferred.includes(b.name) ? 0 : 1),
  );
  // The shared fetch budget caps the whole walk, not each nested loop.
  for (const dir of ordered.slice(0, MAX_FOLDERS_WALKED)) {
    if (found.length >= MAX_SKILLS_PER_IMPORT) break;
    const base = dir.name === ".claude" || dir.name === ".agents" ? `${dir.path}/skills` : dir.path;
    let children: ContentEntry[];
    try {
      children = await listDir(target, base, fetcher);
    } catch (error) {
      if (error instanceof ImportLimitError || (error instanceof Error && error.name === "TimeoutError")) throw error;
      continue;
    }
    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      found.push(base);
      continue;
    }
    for (const child of children.filter((entry) => entry.type === "dir").slice(0, MAX_CHILDREN_PER_FOLDER)) {
      if (found.length >= MAX_SKILLS_PER_IMPORT) break;
      try {
        const inner = await listDir(target, child.path, fetcher);
        if (inner.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) found.push(child.path);
      } catch (error) {
        if (error instanceof ImportLimitError || (error instanceof Error && error.name === "TimeoutError")) throw error;
        // unreadable child — skip
      }
    }
  }
  return found;
}

/** Fetch ONE skill folder's markdown files. `dir` must contain SKILL.md. */
export async function fetchSkillDir(target: Target, dir: string, fetcher: typeof fetch): Promise<FetchedSkill> {
  const entries = await listDir(target, dir, fetcher);
  const markdown = entries
    .filter((entry) => entry.type === "file" && /\.md$/i.test(entry.name) && entry.download_url)
    .slice(0, MAX_FILES);
  if (!markdown.some((entry) => entry.name === "SKILL.md")) {
    throw new Error(`no SKILL.md in ${dir || "the repository root"}`);
  }
  const files: FetchedSkill["files"] = [];
  for (let i = 0; i < markdown.length; i += 4) {
    files.push(...await Promise.all(markdown.slice(i, i + 4).map(async (entry) => ({
      path: entry.name,
      content: await fetchText(entry.download_url!, fetcher),
    }))));
  }
  const ref = target.ref ? `@${target.ref}` : "";
  return { source: `github.com/${target.owner}/${target.repo}${ref}/${dir}`.replace(/\/$/, ""), files };
}

export async function fetchSkillFromSource(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<{ skills: FetchedSkill[] } | { error: string }> {
  const parsed = parseSkillSource(input);
  if ("error" in parsed) return parsed;
  fetcher = boundedImportFetch(fetcher);
  try {
    if ("rawUrl" in parsed) {
      const content = await fetchText(parsed.rawUrl, fetcher);
      return { skills: [{ source: parsed.rawUrl, files: [{ path: "SKILL.md", content }] }] };
    }
    const dirs = await discoverSkillDirs(parsed, fetcher);
    if (!dirs.length) return { error: "no SKILL.md found there — paste a skill folder or a repo with a skills/ directory" };
    const skills: FetchedSkill[] = [];
    for (const dir of dirs) skills.push(await fetchSkillDir(parsed, dir, fetcher));
    return { skills };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
