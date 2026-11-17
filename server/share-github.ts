// Reads a template from a public GitHub link: a repository, a folder (tree/<ref>/<path>), a bot.md or team.md (blob,
// raw), or an older single file (a BotMRR Markdown playbook, a team or package JSON). Security: only https to github.com
// links, fetched from raw.githubusercontent.com with no redirects, no token, a timeout and byte caps, and only the files
// the manifest names (shared/share-folder.ts decides which paths those may be).
import { namedFolderFiles, readShareFolder, SHARE_FOLDER_MAX_BYTES, type ShareFolder, type ShareFolderFiles } from "../shared/share-folder.ts";

type Fetcher = typeof fetch;
const RAW = "https://raw.githubusercontent.com";
const MANIFEST_MAX_BYTES = 1_000_000;
const FOLDER_MANIFESTS = ["bot.md", "team.md"] as const;
const REPOSITORY_FILES = ["bot.md", "team.md", "botmrr.md", "team.mausteam.json"] as const;

export class GithubTemplateError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Where a link's template lives: folders to look in for bot.md or team.md (repository roots also for the older files),
 * or one older single file. */
export type GithubTemplateSource =
  | { kind: "folders"; folders: Array<{ base: string; names: readonly string[] }> }
  | { kind: "file"; url: string; name: string };

const safeSegment = (value: string) => /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";

export function githubTemplateSource(input: string): GithubTemplateSource {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new GithubTemplateError("Paste a GitHub link to a template folder.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new GithubTemplateError("Only public https GitHub links can be imported.");
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new GithubTemplateError("That GitHub link isn't one MausBot can read.");
  }
  if (!parts.every(safeSegment)) throw new GithubTemplateError("That GitHub link isn't one MausBot can read.");
  const fileSource = (owner: string, repo: string, ref: string, path: string[]): GithubTemplateSource => {
    const name = path.at(-1)!;
    const folder = path.slice(0, -1);
    if (name === "bot.md" || name === "team.md") {
      return { kind: "folders", folders: [{ base: [RAW, owner, repo, ref, ...folder].join("/"), names: [name] }] };
    }
    if (!/\.(?:md|json)$/.test(name)) throw new GithubTemplateError("The link must point to a template folder, a bot.md or a team.md.");
    return { kind: "file", url: [RAW, owner, repo, ref, ...path].join("/"), name };
  };
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    const [owner, repo, kind, ref, ...path] = parts;
    if (owner && repo && !kind) {
      return { kind: "folders", folders: ["main", "master"].map((branch) => ({ base: [RAW, owner, repo, branch].join("/"), names: REPOSITORY_FILES })) };
    }
    if (owner && repo && kind === "tree" && ref) {
      return { kind: "folders", folders: [{ base: [RAW, owner, repo, ref, ...path].join("/"), names: path.length ? FOLDER_MANIFESTS : REPOSITORY_FILES }] };
    }
    if (owner && repo && (kind === "blob" || kind === "raw") && ref && path.length) return fileSource(owner, repo, ref, path);
  }
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    const [owner, repo, ref, ...path] = parts;
    return fileSource(owner!, repo!, ref!, path);
  }
  throw new GithubTemplateError("Paste a GitHub link to a repository, a template folder, a bot.md or a team.md.");
}

async function fetchBody(url: string, maxBytes: number, fetcher: Fetcher, binary: boolean): Promise<string | Uint8Array | null> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: binary ? "image/*" : "text/plain, application/json" } });
  } catch {
    throw new GithubTemplateError("Couldn't reach GitHub. Check that you're online and try again.", 502);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubTemplateError(`GitHub answered with an error (${response.status}). Try again in a few minutes.`, 502);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new GithubTemplateError("This template is larger than 4 MB.", 413);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new GithubTemplateError("This template is larger than 4 MB.", 413);
  return binary ? bytes : new TextDecoder().decode(bytes);
}

async function fetchFolder(base: string, names: readonly string[], fetcher: Fetcher): Promise<ShareFolderFiles | null> {
  for (const name of names) {
    const manifest = await fetchBody(`${base}/${name}`, MANIFEST_MAX_BYTES, fetcher, false);
    if (manifest === null) continue;
    const files: ShareFolderFiles = { [name]: manifest };
    let total = typeof manifest === "string" ? manifest.length : manifest.byteLength;
    if (name === "bot.md" || name === "team.md") {
      for (const path of namedFolderFiles(String(manifest))) {
        const body = await fetchBody(`${base}/${path}`, SHARE_FOLDER_MAX_BYTES - total, fetcher, !path.endsWith(".md"));
        if (body === null) continue;
        total += typeof body === "string" ? body.length : body.byteLength;
        files[path] = body;
      }
    }
    return files;
  }
  return null;
}

/** A template folder at a raw.githubusercontent.com address, through the folder reader. */
export async function fetchGithubFolder(base: string, fetcher: Fetcher = fetch): Promise<ShareFolder> {
  const files = await fetchFolder(base, FOLDER_MANIFESTS, fetcher);
  if (!files) throw new GithubTemplateError("No bot.md or team.md was found in that folder.", 404);
  return readShareFolder(files);
}

/** The template a GitHub link points at, through the folder reader. Throws GithubTemplateError or PackageFormatError. */
export async function fetchGithubTemplate(input: string, fetcher: Fetcher = fetch): Promise<ShareFolder> {
  const source = githubTemplateSource(input);
  if (source.kind === "file") {
    const body = await fetchBody(source.url, MANIFEST_MAX_BYTES, fetcher, false);
    if (body === null) throw new GithubTemplateError("Nothing was found at that GitHub link.", 404);
    const key = source.name.endsWith(".json") ? "team.mausteam.json" : "botmrr.md";
    return readShareFolder({ [key]: body });
  }
  for (const folder of source.folders) {
    const files = await fetchFolder(folder.base, folder.names, fetcher);
    if (files) return readShareFolder(files);
  }
  throw new GithubTemplateError("No bot.md or team.md was found at that GitHub link.", 404);
}
