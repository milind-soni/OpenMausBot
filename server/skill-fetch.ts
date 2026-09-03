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
const MAX_LISTING_BYTES = 1024 * 1024;
const API = "https://api.github.com";

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

export interface SkillImportRequest {
  source: string;
  skillName?: string;
}

const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function tokenizeSkillCommand(input: string): string[] | { error: string } {
  const tokens: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(word);
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (escaped || quote) return { error: "malformed quoting in skills import command" };
  if (started) tokens.push(word);
  return tokens;
}

/** Parse the documented CLI-shaped input as data. Nothing here invokes npx,
 * a shell, or any command from the pasted string. */
export function parseSkillImportInput(input: string): SkillImportRequest | { error: string } {
  const tokenized = tokenizeSkillCommand(input.trim());
  if ("error" in tokenized) return tokenized;
  if (tokenized.length === 1) return { source: tokenized[0]! };
  if (tokenized[0] !== "npx" || tokenized[1] !== "skills" || tokenized[2] !== "add") {
    return { error: "only `npx skills add <GitHub source> --skill <name>` is supported" };
  }
  let source: string | undefined;
  let skillName: string | undefined;
  for (let index = 3; index < tokenized.length; index += 1) {
    const value = tokenized[index]!;
    if (value === "--skill" || value === "-s") {
      const name = tokenized[++index];
      if (!name) return { error: `${value} requires an exact skill name` };
      if (skillName) return { error: "the skills import command accepts one --skill selector" };
      if (!SAFE_SKILL_NAME.test(name)) return { error: `invalid skill name "${name}"` };
      skillName = name;
    } else if (value.startsWith("-")) {
      return { error: `unknown skills import flag "${value}"` };
    } else if (source) {
      return { error: "the skills import command accepts exactly one GitHub source" };
    } else {
      source = value;
    }
  }
  if (!source) return { error: "the skills import command needs a GitHub source" };
  if (!skillName) return { error: "the skills import command needs --skill <name>" };
  return { source, skillName };
}

const GITHUB_TRACKING_QUERY_KEYS = new Set(["ysclid"]);

/** Strip only known tracking metadata. Unknown query parameters and all
 * fragments stay invalid instead of being silently reinterpreted. */
function normalizeGitHubTrackingQuery(input: string): string {
  if (!/^https?:\/\/github\.com\//i.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== "github.com" || !url.search || url.hash) return input;
    const keys = [...url.searchParams.keys()];
    if (!keys.length || keys.some((key) => !GITHUB_TRACKING_QUERY_KEYS.has(key.toLowerCase()))) return input;
    return input.slice(0, input.indexOf("?"));
  } catch {
    return input;
  }
}

/** owner/repo, github.com/owner/repo[/tree/<ref>/<path>], or a raw/blob URL
 * straight to a SKILL.md. Anything else is refused, loudly. */
export function parseSkillSource(input: string): Target | { rawUrl: string } | { error: string } {
  const text = normalizeGitHubTrackingQuery(input.trim());
  if (!text) return { error: "paste a GitHub repository, folder, or SKILL.md URL" };
  if (/^https?:\/\/github\.com\//i.test(text) && /[?#]/.test(text)) {
    return { error: "that does not look like a GitHub repository, folder, or SKILL.md URL" };
  }
  if (/^https:\/\/raw\.githubusercontent\.com\/.+\/SKILL\.md$/i.test(text)) return { rawUrl: text };
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

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new Error("GitHub response is larger than the import cap");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("GitHub response is larger than the import cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("GitHub response is not valid UTF-8 text");
  }
}

function asEntries(listing: z.infer<typeof CONTENT_LISTING>): ContentEntry[] {
  return listing.flatMap((item) => {
    const entry = CONTENT_ENTRY.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

async function fetchListing(url: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const response = await fetcher(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "OpenMausBot-skills" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  let payload: unknown;
  try {
    payload = JSON.parse(await boundedResponseText(response, MAX_LISTING_BYTES));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("GitHub API returned invalid JSON");
    throw error;
  }
  return asEntries(CONTENT_LISTING.parse(payload));
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("GitHub returned an invalid download URL");
  }
  if (
    parsed.origin !== "https://raw.githubusercontent.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("GitHub returned an unsupported download URL");
  }
  const response = await fetcher(parsed.href, {
    headers: { "user-agent": "OpenMausBot-skills" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return boundedResponseText(response, MAX_FILE_BYTES).catch((error) => {
    if (error instanceof Error && error.message.includes("larger than")) {
      throw new Error("file is larger than the 256KB import cap");
    }
    throw error;
  });
}

async function listDir(target: Target, path: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : "";
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodedPath}${ref}`;
  return fetchListing(url, fetcher);
}

/** Where SKILL.md folders live in real repos, per the registry's own
 * discovery order: the pasted path itself, then skills/, then .claude/skills/
 * and .agents/skills/, then one level of direct children. */
export async function discoverSkillDirs(
  target: Target,
  fetcher: typeof fetch,
  requestedSkillName?: string,
): Promise<string[]> {
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
  const orderedDirs = requestedSkillName ? ordered : ordered.slice(0, 12);
  const matchesRequestedSkill = async (entries: ContentEntry[]): Promise<boolean> => {
    if (!requestedSkillName) return true;
    const skillMd = entries.find((entry) => entry.type === "file" && entry.name === "SKILL.md" && entry.download_url);
    if (!skillMd?.download_url) return false;
    try {
      return declaredSkillName(await fetchText(skillMd.download_url, fetcher)) === requestedSkillName;
    } catch {
      return false;
    }
  };
  for (const dir of orderedDirs) {
    if (!requestedSkillName && found.length >= 10) break;
    const base = dir.name === ".claude" || dir.name === ".agents" ? `${dir.path}/skills` : dir.path;
    let children: ContentEntry[];
    try {
      children = await listDir(target, base, fetcher);
    } catch {
      continue;
    }
    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      if (requestedSkillName) {
        if (await matchesRequestedSkill(children)) return [base];
      } else {
        found.push(base);
      }
      continue;
    }
    const childDirs = children.filter((entry) => entry.type === "dir");
    for (const child of (requestedSkillName ? childDirs : childDirs.slice(0, 20))) {
      if (!requestedSkillName && found.length >= 10) break;
      try {
        const inner = await listDir(target, child.path, fetcher);
        if (inner.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
          if (requestedSkillName) {
            if (await matchesRequestedSkill(inner)) return [child.path];
          } else {
            found.push(child.path);
          }
        }
      } catch {
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
  const files = await Promise.all(
    markdown.map(async (entry) => ({
      path: entry.name,
      content: await fetchText(entry.download_url!, fetcher),
    })),
  );
  const ref = target.ref ? `@${target.ref}` : "";
  return { source: `github.com/${target.owner}/${target.repo}${ref}/${dir}`.replace(/\/$/, ""), files };
}

/** Match the installer's narrow frontmatter field semantics without coupling
 * the fetch boundary to workspace storage: keys are case-insensitive and a
 * later duplicate replaces an earlier value. */
function declaredSkillName(manifest: string | undefined): string | undefined {
  const frontmatter = manifest?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return undefined;
  let name: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field?.[1]?.toLowerCase() !== "name") continue;
    name = field[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return name;
}

/** Parse and fetch one GitHub/skills import request without executing the
 * pasted command, optionally narrowing the result to one declared skill. */
export async function fetchSkillFromSource(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<{ skills: FetchedSkill[] } | { error: string }> {
  const request = parseSkillImportInput(input);
  if ("error" in request) return request;
  const parsed = parseSkillSource(request.source);
  if ("error" in parsed) return parsed;
  try {
    let skills: FetchedSkill[];
    if ("rawUrl" in parsed) {
      const content = await fetchText(parsed.rawUrl, fetcher);
      skills = [{ source: parsed.rawUrl, files: [{ path: "SKILL.md", content }] }];
    } else {
      const dirs = await discoverSkillDirs(parsed, fetcher, request.skillName);
      if (!dirs.length) {
        return {
          error: request.skillName
            ? `requested skill not found: ${request.skillName}`
            : "no SKILL.md skill manifest found — paste a skill folder or a repo with a skills/ directory",
        };
      }
      skills = await Promise.all(dirs.map((dir) => fetchSkillDir(parsed, dir, fetcher)));
    }
    if (!request.skillName) return { skills };
    const selected = skills.find((skill) => {
      const manifest = skill.files.find((file) => file.path === "SKILL.md")?.content;
      return declaredSkillName(manifest) === request.skillName;
    });
    if (!selected) return { error: `requested skill not found: ${request.skillName}` };
    return { skills: [selected] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
