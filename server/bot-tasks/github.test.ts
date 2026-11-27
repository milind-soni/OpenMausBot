import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubClient, GithubError, ownCommentMarker, redactToken, resolveGithubToken } from "./github.ts";

const api = "https://api.github.com";
const token = "synthetic-test-credential";
const ref = { repo: "octo/example", number: 42 };
const repo = "/repos/octo/example";
const issue = `${repo}/issues/42`;
const pr = `${repo}/pulls/42`;
const now = Date.parse("2026-11-20T12:00:00Z");
const old = "2026-11-20T11:00:00Z";
const recent = "2026-11-20T13:00:00Z";
const url = "https://github.com/octo/example/pull/42";
const pull = { state: "open", mergeable: true, head: { sha: "abc" }, html_url: url, title: "Update" };

function fixture(fetch: typeof globalThis.fetch) {
  return createGithubClient({ token: async () => token, fetch, now: () => now });
}

describe("GitHub credentials", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the configured token or caches the shell-free gh lookup for 60 seconds", async () => {
    vi.useFakeTimers();
    const exec = vi.fn(async () => ({ stdout: ` ${token}\n` }));
    await expect(resolveGithubToken("vault", "  saved  ", { exec })).resolves.toBe("saved");
    await expect(resolveGithubToken("vault", undefined, { exec })).resolves.toBeNull();
    expect(exec).not.toHaveBeenCalled();
    await expect(Promise.all([
      resolveGithubToken("gh", undefined, { exec }),
      resolveGithubToken("gh", undefined, { exec }),
    ])).resolves.toEqual([token, token]);
    expect(exec).toHaveBeenCalledExactlyOnceWith("gh", ["auth", "token"], { timeout: 5000, encoding: "utf8" });
    vi.advanceTimersByTime(59_999);
    await resolveGithubToken("gh", undefined, { exec });
    expect(exec).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await resolveGithubToken("gh", undefined, { exec });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("handles an unavailable gh command without exposing its error", async () => {
    const exec = vi.fn(async () => { throw new Error(token); });
    await expect(resolveGithubToken("gh", undefined, { exec })).resolves.toBeNull();
    expect(redactToken(`Denied ${token} and ghp_testToken`, token)).toBe("Denied [REDACTED] and [REDACTED]");
  });
});

describe("GitHub task client", () => {
  it("identifies the viewer and falls back from a missing PR to an issue", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("user-agent")).toBe("openmausbot-bot-tasks");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(init).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
      switch (String(input)) {
        case `${api}/user`: return Response.json({ login: "octocat" });
        case `${api}${pr}`: return new Response(null, { status: 404 });
        case `${api}${issue}`:
          return Response.json({ state: "closed", html_url: url, title: "Issue", closed_at: recent });
        default: throw new Error("Unexpected fixture request");
      }
    });
    const client = fixture(fetch);
    await expect(client.viewer()).resolves.toBe("octocat");
    await expect(client.pull(ref.repo, ref.number)).resolves.toMatchObject({
      kind: "issue", state: "closed", mergeable: null, headSha: null, htmlUrl: url, title: "Issue", closedAt: recent,
    });
    await expect(client.pull("octo/..", 42)).rejects.toThrow("Invalid GitHub repository");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("normalizes paginated comments, reviews, state changes and the latest completed checks", async () => {
    const comment = { created_at: recent, html_url: url, user: { login: "dev" } };
    const run = { name: "build", status: "completed", html_url: url, app: { slug: "actions" } };
    const status = { context: "test", creator: { login: "ci" }, created_at: old, target_url: url };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const endpoint = new URL(String(input));
      switch (endpoint.pathname) {
        case pr: return Response.json(pull);
        case `${issue}/comments`:
          if (endpoint.searchParams.has("page")) return Response.json([{ ...comment, id: 2, body: "second" }]);
          return Response.json([
            { ...comment, id: 1, body: "a".repeat(4001) },
            { ...comment, id: 3, created_at: old, body: "was only edited recently" },
          ], { headers: { link: `<${api}/repositories/123/issues/42/comments?page=2>; rel="next"` } });
        case `${pr}/comments`:
          return Response.json([{ ...comment, id: 4, body: `${"a".repeat(4001)}\n${ownCommentMarker("task-42")}` }]);
        case `${pr}/reviews`:
          return Response.json([
            { ...comment, id: 1, submitted_at: recent, state: "APPROVED", body: "looks good" },
            { ...comment, id: 2, submitted_at: old, state: "APPROVED", body: "old review" },
            { ...comment, id: 3, state: "PENDING" },
          ]);
        case `${issue}/events`:
          return Response.json([{ event: "reopened", created_at: recent, actor: { login: "maintainer" } }]);
        case `${repo}/commits/abc/check-runs`:
          return Response.json({ check_runs: [
            { ...run, completed_at: old, conclusion: "failure" },
            { ...run, completed_at: recent, conclusion: "success" },
            { ...run, name: "pending", status: "in_progress", completed_at: null, conclusion: null },
          ] });
        case `${repo}/commits/abc/statuses`:
          return Response.json([{ ...status, state: "success" }, { ...status, context: "pending", state: "pending" }]);
        default: throw new Error("Unexpected fixture request");
      }
    });
    const events = await fixture(fetch).events(ref, now);
    expect(events.map(({ key }) => key)).toEqual([
      "comment:1", "comment:2", "review-comment:4", "review:1",
      `state:reopened:${Date.parse(recent)}`, "check:build:abc:success",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      key: "comment:1", text: "a".repeat(4000), login: "dev", url,
    }));
    expect(events).toContainEqual(expect.objectContaining({ key: "review-comment:4", ownMarker: true }));
    expect(events).toContainEqual(expect.objectContaining({ key: "review:1", state: "APPROVED", text: "looks good" }));
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it.each([403, 429])("surfaces HTTP %s rate limits without exposing response content", async (status) => {
    const client = fixture(async () => Response.json({ message: token }, { status, headers: { "retry-after": "20" } }));
    const error = await client.viewer().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GithubError);
    expect(error).toMatchObject({ message: "GitHub rate limit exceeded", status, resetAt: now + 20_000 });
    expect(String(error)).not.toContain(token);
  });

  it("does not echo credential errors, HTTP bodies or network errors", async () => {
    const missing = createGithubClient({ token: async () => { throw new Error(token); } });
    const invalid = fixture(async () => Response.json({ message: token }, { status: 401 }));
    const failed = fixture(async () => { throw new Error(token); });
    await expect(missing.viewer()).rejects.toThrow(/^GitHub token missing or invalid$/);
    await expect(invalid.viewer()).rejects.toThrow(/^GitHub token missing or invalid$/);
    await expect(failed.viewer()).rejects.toThrow(/^GitHub network request failed$/);
  });

  it("caps pagination at five pages and rejects off-origin next links", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const endpoint = new URL(String(input));
      if (endpoint.pathname === pr) return new Response(null, { status: 404 });
      if (endpoint.pathname === issue) return Response.json(pull);
      if (endpoint.pathname === `${issue}/events`) {
        return Response.json([], { headers: { link: '<https://other.example/events?page=2>; rel="next"' } });
      }
      const page = Number(endpoint.searchParams.get("page") ?? 1);
      expect(endpoint.origin).toBe(api);
      expect(endpoint.pathname).toBe(`${issue}/comments`);
      return Response.json([], { headers: { link: `<?page=${page + 1}>; rel="next"` } });
    });
    await expect(fixture(fetch).events(ref, now)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("reads the linked pull request's commit list across pages for evidence", async () => {
    const fakeFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const endpoint = new URL(String(input));
      if (endpoint.pathname === pr) return Response.json(pull);
      expect(endpoint.pathname).toBe(`${pr}/commits`);
      if (endpoint.searchParams.get("page") === "2") return Response.json([{ sha: "second" }]);
      return Response.json([{ sha: "first" }], { headers: { link: '<?page=2>; rel="next"' } });
    });
    await expect(fixture(fakeFetch).pullCommitEvidence(ref)).resolves.toEqual({ shas: ["first", "second"], complete: true });
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("uses a bounded GET for evidence and a fixed GitHub API origin", async () => {
    const fakeFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe(`${api}${repo}/commits/abc1234`);
      expect(init).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
      return Response.json({ sha: "abc1234" });
    });
    const client = fixture(fakeFetch);
    await expect(client.lookupEvidence(`${repo}/commits/abc1234`)).resolves.toEqual({ sha: "abc1234" });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("reads recent pages first for large historical collections and backfills previous-head checks", async () => {
    const visited: number[] = [];
    const fakeFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const endpoint = new URL(String(input));
      const page = Number(endpoint.searchParams.get("page") ?? 1);
      if (endpoint.pathname === pr) return Response.json(pull);
      if (endpoint.pathname === `${pr}/commits`) return Response.json([{ sha: "older" }, { sha: "abc" }]);
      if (endpoint.pathname === `${issue}/comments`) {
        visited.push(page);
        const target = `${api}${issue}/comments`;
        const link = page === 1 ? `<${target}?page=2>; rel="next", <${target}?page=9>; rel="last"`
          : `<${target}?page=${page - 1}>; rel="prev"`;
        return Response.json([{ id: page, body: "comment", created_at: old, html_url: url }], { headers: { link } });
      }
      if (endpoint.pathname.endsWith("/check-runs")) {
        const check_runs = endpoint.pathname.includes("/older/") ? [{
          id: 77, name: "earlier build", status: "completed", conclusion: "success", completed_at: old, html_url: url,
        }] : [];
        return Response.json({ check_runs });
      }
      return Response.json([]);
    });
    const events = await fixture(fakeFetch).events(ref, 0);
    expect(visited).toEqual([1, 9, 8, 7, 6]);
    expect(events).toContainEqual(expect.objectContaining({ key: "check-run:77", at: Date.parse(old) }));
  });

  it("adds the marker to outbound comments and redacts credentials in merge results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === `${api}${issue}/comments`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ body: "Update\n\n<!-- omb-bot-task:task-42 -->" });
        return Response.json({ id: 5, html_url: url }, { status: 201 });
      }
      expect(String(input)).toBe(`${api}${pr}/merge`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ sha: "a".repeat(40), merge_method: "squash" });
      return Response.json({ merged: true, sha: "def", message: `Done ${token}` });
    });
    const client = fixture(fetch);
    await expect(client.postComment({ ...ref, taskId: "task-42" }, "Update")).resolves.toEqual({ id: 5, url });
    await expect(client.merge(ref, { sha: "a".repeat(40), method: "squash" })).resolves.toEqual({
      merged: true, sha: "def", message: "Done [REDACTED]",
    });
  });
});
