// Public GitHub repositories served from memory, as the skill import reads them: the API's commits, contents and
// trees endpoints, and the raw file host. Contents and trees answer only at the commit a ref resolved to.
import { createHash } from "node:crypto";

export type FakeRepoEntry =
  | string
  | Buffer
  | { content: string | Buffer; executable?: boolean }
  | { link: string }
  | { submodule: true };

export interface FakeGitHubOptions {
  /** Raw downloads of these repository paths answer with other bytes than the commit holds. */
  tamper?: string[];
  /** Every API request answers 403 with no requests left, as GitHub does past its hourly limit without sign-in. */
  rateLimited?: boolean;
  /** Any other host is fetched with this, such as the real fetch for a local test server. */
  passThrough?: typeof fetch;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  /** Every GitHub URL requested, in order. */
  requests: string[];
  commitOf(repo: string): string;
}

const sha1 = (text: string | Buffer) => createHash("sha1").update(text).digest("hex");
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

interface Node {
  path: string;
  kind: "file" | "folder" | "link" | "submodule";
  bytes: Buffer;
  executable: boolean;
  sha: string;
}

function nodesOf(repo: string, entries: Record<string, FakeRepoEntry>): Map<string, Node> {
  const nodes = new Map<string, Node>();
  for (const [path, entry] of Object.entries(entries)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!nodes.has(folder)) nodes.set(folder, { path: folder, kind: "folder", bytes: Buffer.alloc(0), executable: false, sha: sha1(`tree ${repo}:${folder}`) });
    }
    if (typeof entry === "string" || Buffer.isBuffer(entry)) {
      const bytes = Buffer.from(entry);
      nodes.set(path, { path, kind: "file", bytes, executable: false, sha: blobSha(bytes) });
    } else if ("link" in entry) {
      const bytes = Buffer.from(entry.link);
      nodes.set(path, { path, kind: "link", bytes, executable: false, sha: blobSha(bytes) });
    } else if ("submodule" in entry) {
      nodes.set(path, { path, kind: "submodule", bytes: Buffer.alloc(0), executable: false, sha: sha1(`submodule ${repo}:${path}`) });
    } else {
      const bytes = Buffer.from(entry.content);
      nodes.set(path, { path, kind: "file", bytes, executable: Boolean(entry.executable), sha: blobSha(bytes) });
    }
  }
  return nodes;
}

const MODES = { file: "100644", folder: "040000", link: "120000", submodule: "160000" } as const;
const TYPES = { file: "blob", folder: "tree", link: "blob", submodule: "commit" } as const;
const CONTENT_TYPES = { file: "file", folder: "dir", link: "symlink", submodule: "submodule" } as const;

export function fakeGitHub(repos: Record<string, Record<string, FakeRepoEntry>>, options: FakeGitHubOptions = {}): FakeGitHub {
  const trees = new Map(Object.entries(repos).map(([repo, entries]) => [repo, nodesOf(repo, entries)]));
  const commitOf = (repo: string) => sha1(`commit ${repo}`);
  const requests: string[] = [];
  const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
  const children = (nodes: Map<string, Node>, folder: string) =>
    [...nodes.values()].filter((node) => node.path.startsWith(folder ? `${folder}/` : "") && !node.path.slice(folder ? folder.length + 1 : 0).includes("/"));

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.github.com" && url.hostname !== "raw.githubusercontent.com") {
      if (options.passThrough) return options.passThrough(input, init);
      throw new TypeError(`fake GitHub: no route for ${url}`);
    }
    requests.push(String(input));
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.hostname === "raw.githubusercontent.com") {
      const [owner, name, , ...path] = segments;
      const node = trees.get(`${owner}/${name}`)?.get(path.join("/"));
      if (!node || node.kind !== "file") return notFound();
      const tampered = options.tamper?.includes(path.join("/"));
      return new Response(tampered ? Buffer.concat([node.bytes, Buffer.from("\n# changed")]) : node.bytes);
    }
    if (options.rateLimited) {
      return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    }
    const [repos_, owner, name, endpoint, ...rest] = segments;
    const repo = `${owner}/${name}`;
    const nodes = trees.get(repo);
    if (repos_ !== "repos" || !nodes) return notFound();
    const commit = commitOf(repo);
    if (endpoint === "commits") return new Response(commit);
    if (endpoint === "contents") {
      if (url.searchParams.get("ref") !== commit) return notFound();
      const path = rest.join("/");
      if (path && nodes.get(path)?.kind !== "folder") return nodes.has(path) ? Response.json({ type: "file", path }) : notFound();
      return Response.json(children(nodes, path).map((node) => ({
        type: CONTENT_TYPES[node.kind],
        name: node.path.split("/").at(-1),
        path: node.path,
        sha: node.sha,
        size: node.bytes.length,
        download_url: node.kind === "file" ? `https://raw.githubusercontent.com/${repo}/${commit}/${node.path}` : null,
      })));
    }
    if (endpoint === "git" && rest[0] === "trees") {
      const sha = rest[1];
      const folder = sha === commit ? "" : [...nodes.values()].find((node) => node.kind === "folder" && node.sha === sha)?.path;
      if (folder === undefined) return notFound();
      const below = [...nodes.values()].filter((node) => !folder || node.path.startsWith(`${folder}/`))
        .map((node) => ({ ...node, path: folder ? node.path.slice(folder.length + 1) : node.path }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      return Response.json({
        sha,
        truncated: false,
        tree: below.map((node) => ({
          path: node.path,
          mode: node.kind === "file" && node.executable ? "100755" : MODES[node.kind],
          type: TYPES[node.kind],
          sha: node.sha,
          ...(node.kind === "folder" || node.kind === "submodule" ? {} : { size: node.bytes.length }),
        })),
      });
    }
    return notFound();
  }) as typeof fetch;

  return { fetch: fetcher, requests, commitOf };
}
