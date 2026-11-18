// A GitHub repository behind a fake connected-apps relay, for template tests: the MCP frames a template's GitHub reads
// and writes send (initialize, then COMPOSIO_MULTI_EXECUTE_TOOL) answered from memory, with no network.
import { createHash } from "node:crypto";

import type { GithubRelay } from "../share-github-repo.ts";

type Tree = Map<string, Uint8Array>;

export interface FakeGithubRepo {
  relay: GithubRelay;
  /** Every tool call, by slug and arguments. */
  calls: Array<{ slug: string; args: Record<string, unknown> }>;
  branches: Map<string, Tree>;
  pulls: Array<{ head: string; base: string; title: string }>;
  /** Puts a file on a branch, as a person's own commit would. */
  put(branch: string, path: string, content: string | Uint8Array): void;
}

const sha = (value: string) => createHash("sha1").update(value).digest("hex");

export function fakeGithubRepo(options: { owner: string; repo: string; push?: boolean; pullUrl?: string }): FakeGithubRepo {
  const branches = new Map<string, Tree>([["main", new Map()]]);
  const blobs = new Map<string, Uint8Array>(), trees = new Map<string, Tree>(), commits = new Map<string, { tree: string; parents: string[] }>();
  const heads = new Map<string, string>([["main", "c0"]]);
  commits.set("c0", { tree: "t0", parents: [] });
  trees.set("t0", new Map());
  const calls: FakeGithubRepo["calls"] = [];
  const pulls: FakeGithubRepo["pulls"] = [];
  const ok = (data: unknown) => ({ successful: true, data });
  const fail = (error: string) => ({ successful: false, error });
  const mine = (args: Record<string, unknown>) => args.owner === options.owner && args.repo === options.repo;
  const commitTo = (branch: string, commit: string) => {
    heads.set(branch, commit);
    branches.set(branch, new Map(trees.get(commits.get(commit)!.tree)!));
  };

  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    GITHUB_GET_A_REPOSITORY: () => ok({ default_branch: "main", ...(options.push === undefined ? {} : { permissions: { push: options.push } }) }),
    GITHUB_GET_REPOSITORY_CONTENT: (args) => {
      const file = branches.get(String(args.ref))?.get(String(args.path));
      return file ? ok({ type: "file", encoding: "base64", size: file.byteLength, content: Buffer.from(file).toString("base64") }) : fail("Not Found");
    },
    GITHUB_GET_A_BRANCH: (args) => {
      const head = heads.get(String(args.branch));
      return head ? ok({ name: args.branch, commit: { sha: head, commit: { tree: { sha: commits.get(head)!.tree } } } }) : fail("Branch not found");
    },
    GITHUB_CREATE_A_BLOB: (args) => {
      const bytes = new Uint8Array(Buffer.from(String(args.content), "base64"));
      const id = sha(`blob:${Buffer.from(bytes).toString("hex")}`);
      blobs.set(id, bytes);
      return ok({ sha: id });
    },
    GITHUB_CREATE_A_TREE: (args) => {
      const tree = new Map(trees.get(String(args.base_tree)) ?? []);
      for (const entry of args.tree as Array<{ path: string; sha: string }>) tree.set(entry.path, blobs.get(entry.sha)!);
      const id = sha(`tree:${[...tree.keys()].join(",")}:${trees.size}`);
      trees.set(id, tree);
      return ok({ sha: id });
    },
    GITHUB_CREATE_A_COMMIT: (args) => {
      const id = sha(`commit:${String(args.tree)}:${commits.size}`);
      commits.set(id, { tree: String(args.tree), parents: args.parents as string[] });
      return ok({ sha: id });
    },
    GITHUB_CREATE_A_REFERENCE: (args) => {
      commitTo(String(args.ref).replace(/^refs\/heads\//, ""), String(args.sha));
      return ok({ ref: args.ref });
    },
    GITHUB_UPDATE_A_REFERENCE: (args) => {
      if (options.push === false) return fail("Resource not accessible by integration");
      commitTo(String(args.ref).replace(/^heads\//, ""), String(args.sha));
      return ok({ ref: args.ref });
    },
    GITHUB_CREATE_A_PULL_REQUEST: (args) => {
      pulls.push({ head: String(args.head), base: String(args.base), title: String(args.title) });
      return ok({ number: pulls.length, html_url: options.pullUrl ?? `https://github.com/${options.owner}/${options.repo}/pull/${pulls.length}` });
    },
  };

  const relay: GithubRelay = async (payload) => {
    const frame = payload as { id?: string; method: string; params?: { name?: string; arguments?: { tools?: Array<{ tool_slug: string; arguments: Record<string, unknown> }> } } };
    const answer = (body: unknown) => ({ status: 200, bytes: new TextEncoder().encode(JSON.stringify(body)), transportSessionId: "fake-session" });
    if (frame.method === "initialize") return answer({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-03-26", capabilities: {} } });
    if (frame.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
    const results = (frame.params?.arguments?.tools ?? []).map((tool) => {
      calls.push({ slug: tool.tool_slug, args: tool.arguments });
      const run = tools[tool.tool_slug];
      const response = !run ? fail(`Unknown tool ${tool.tool_slug}`) : mine(tool.arguments) ? run(tool.arguments) : fail("Not Found");
      return { tool_slug: tool.tool_slug, response };
    });
    return answer({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results } }) }] } });
  };

  return {
    relay, calls, branches, pulls,
    put(branch, path, content) {
      branches.get(branch)!.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
    },
  };
}
