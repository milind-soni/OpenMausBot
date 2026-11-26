import { afterEach, describe, expect, it, vi } from "vitest";

import { githubToken, provideGithubSignIn } from "./github/token.ts";
import { fetchSkillFromSource, githubSkillLink, latestSkillCommit, parseSkillSource, skillImportToken } from "./skill-fetch.ts";
import { SKILL_FOLDER_LIMITS } from "./skill-folder.ts";
import { fakeGitHub, type FakeRepoEntry } from "./testing/fake-github.ts";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: Does ${name} things.\n---\n\n# ${name}\n`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe]);

/** A skill folder as people publish them: references, scripts that run, binary assets, folders inside folders. */
const PDF_SKILL: Record<string, FakeRepoEntry> = {
  "skills/pdf/SKILL.md": SKILL("pdf"),
  "skills/pdf/forms.md": "# Forms\nRead references/fields.md first.\n",
  "skills/pdf/references/fields.md": "# Fields\n",
  "skills/pdf/references/deep/nested/more/table.md": "| a | b |\n",
  "skills/pdf/scripts/fill.py": { content: "#!/usr/bin/env python3\nprint('fill')\n", executable: true },
  "skills/pdf/scripts/helpers/common.py": "def helper():\n    return 1\n",
  "skills/pdf/assets/logo.png": PNG,
  "README.md": "# repo\n",
};

const ok = <T,>(result: { skills: T[] } | { error: string }) => {
  if ("error" in result) throw new Error(result.error);
  return result.skills;
};

const SIGNED_IN = "gho_syntheticSkillImportToken";
const OWNER_SIGN_IN = "gho_ownerSignInMustNotLeak";

afterEach(() => provideGithubSignIn(null));

function recordingFetch(inner: typeof fetch) {
  const calls: Array<{ url: string; headers: Headers; redirect: RequestInit["redirect"] }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    return inner(input, init);
  };
  return { fetch: fetcher, calls };
}

const apiCalls = <T extends { url: string }>(calls: readonly T[]) => calls.filter((call) => call.url.startsWith("https://api.github.com/"));
const rawCalls = <T extends { url: string }>(calls: readonly T[]) => calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"));

describe("importing a skill's whole folder", () => {
  it.each([
    "https://github.com/a/b/tree/feature%2Fpdf/skills/pdf",
    "https://github.com/a/b/blob/feature%2Fpdf/skills/pdf/SKILL.md",
    "https://raw.githubusercontent.com/a/b/feature%2Fpdf/skills/pdf/SKILL.md",
    "https://raw.githubusercontent.com/a/b/refs/heads/feature%2Fpdf/skills/pdf/SKILL.md",
  ])("decodes the branch segment once when importing %s", async (source) => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const expected = "https://api.github.com/repos/a/b/commits/feature%2Fpdf";
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).includes("/commits/") && String(input) !== expected) return new Response(null, { status: 404 });
      return github.fetch(input, init);
    };
    expect(parseSkillSource(source)).toMatchObject({ ref: "feature/pdf", path: "skills/pdf" });
    const [skill] = ok(await fetchSkillFromSource(source, fetcher));
    expect(skill!.github).toMatchObject({ ref: "feature/pdf", commit: github.commitOf("a/b") });
    expect(github.requests[0]).toBe(expected);
    const [updated] = ok(await fetchSkillFromSource(githubSkillLink(skill!.github!), fetcher));
    expect(updated!.github).toEqual(skill!.github);
  });

  it("preserves literal percent escapes in a branch and rejects malformed URL escapes", () => {
    expect(parseSkillSource("https://github.com/a/b/tree/feature%252Fpdf/skills/pdf")).toMatchObject({ ref: "feature%2Fpdf" });
    expect(parseSkillSource("https://github.com/a/b/tree/bad%ZZ/skills/pdf")).toHaveProperty("error");
  });

  it("brings in every file below the folder at one commit, binaries and executable bits included", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", github.fetch));
    const commit = github.commitOf("a/b");
    expect(skill!.files.map((file) => file.path)).toEqual([
      "SKILL.md", "forms.md", "assets/logo.png", "references/fields.md", "scripts/fill.py",
      "scripts/helpers/common.py", "references/deep/nested/more/table.md",
    ]);
    const byPath = new Map(skill!.files.map((file) => [file.path, file]));
    expect(byPath.get("assets/logo.png")!.content.equals(PNG)).toBe(true);
    expect(byPath.get("scripts/fill.py")!.executable).toBe(true);
    expect(byPath.get("scripts/helpers/common.py")!.executable).toBe(false);
    expect(skill!.skipped).toEqual([]);
    expect(skill!.source).toBe("github.com/a/b@main/skills/pdf");
    expect(skill!.github).toEqual({ owner: "a", repo: "b", ref: "main", commit, path: "skills/pdf" });
    const listings = github.requests.filter((url) => url.includes("/contents/"));
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((url) => url.endsWith(`?ref=${commit}`))).toBe(true);
    const downloads = github.requests.filter((url) => url.startsWith("https://raw.githubusercontent.com/"));
    expect(downloads).toHaveLength(7);
    expect(downloads.every((url) => url.startsWith(`https://raw.githubusercontent.com/a/b/${commit}/skills/pdf/`))).toBe(true);
    expect(github.requests.filter((url) => url.includes("/git/trees/"))).toHaveLength(1);
  });

  it("sends the connected GitHub sign-in on every API request and keeps raw downloads anonymous", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const recorded = recordingFetch(github.fetch);
    let lookups = 0;
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", recorded.fetch, undefined, async () => {
      lookups += 1;
      return { token: SIGNED_IN };
    }));
    expect(skill!.github?.commit).toBe(github.commitOf("a/b"));
    const api = apiCalls(recorded.calls);
    const raw = rawCalls(recorded.calls);
    expect(api.length).toBeGreaterThan(1);
    expect(lookups).toBe(1);
    expect(api.some((call) => call.url.includes("/commits/"))).toBe(true);
    expect(api.some((call) => call.url.includes("/contents/"))).toBe(true);
    expect(api.some((call) => call.url.includes("/git/trees/"))).toBe(true);
    expect(recorded.calls.every((call) => !call.url.includes(SIGNED_IN))).toBe(true);
    expect(api.every((call) => call.headers.get("authorization") === `Bearer ${SIGNED_IN}`)).toBe(true);
    expect(api.find((call) => call.url.includes("/commits/"))?.headers.get("accept")).toBe("application/vnd.github.sha");
    expect(api.every((call) => call.redirect === "manual")).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((call) => call.headers.get("authorization") === null && call.redirect === "error")).toBe(true);
  });

  it("cancels the import while the GitHub credential lookup is still pending", async () => {
    let release: (signIn: { token: string | null }) => void = () => {};
    const credential = new Promise<{ token: string | null }>((resolve) => { release = resolve; });
    let markEntered: () => void = () => {};
    const getterEntered = new Promise<void>((resolve) => { markEntered = resolve; });
    const fetchSpy = vi.fn(async () => new Response("unused")) as typeof fetch;
    const controller = new AbortController();
    const result = fetchSkillFromSource("a/b", fetchSpy, controller.signal, async () => {
      markEntered();
      return credential;
    });
    try {
      await getterEntered;
      controller.abort(new Error("fixture import cancelled"));
      const checkpoint = new Promise<void>((resolve) => { setImmediate(resolve); });
      const settled = await Promise.race([
        result.then((value) => ({ settled: true as const, value })),
        checkpoint.then(() => ({ settled: false as const })),
      ]);
      expect(settled).toEqual({ settled: true, value: { error: "fixture import cancelled" } });
      release({ token: SIGNED_IN });
      release = () => {};
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      release({ token: null });
    }
  });

  it("stays anonymous when the sign-in getter has no token", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const recorded = recordingFetch(github.fetch);
    let lookups = 0;
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", recorded.fetch, undefined, async () => {
      lookups += 1;
      return { token: null };
    }));
    expect(skill!.files.length).toBeGreaterThan(0);
    const api = apiCalls(recorded.calls);
    const raw = rawCalls(recorded.calls);
    expect(api.length).toBeGreaterThan(1);
    expect(lookups).toBe(1);
    expect(api.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    expect(recorded.calls.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(api.every((call) => call.redirect === undefined)).toBe(true);
    expect(raw.every((call) => call.redirect === "error")).toBe(true);
  });

  it("stays anonymous for an explicit empty sign-in even when the server holds an owner token", async () => {
    const asked: Array<string | null | undefined> = [];
    provideGithubSignIn({
      token: async (audience) => { asked.push(audience); return OWNER_SIGN_IN; },
      reportAuthFailure: () => {},
      signedIn: () => true,
    });
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const recorded = recordingFetch(github.fetch);
    ok(await fetchSkillFromSource("a/b", recorded.fetch, undefined, async () => ({ token: null })));
    expect(recorded.calls.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(JSON.stringify(recorded.calls)).not.toContain(OWNER_SIGN_IN);
    expect(asked).toEqual([]);
  });

  it("does not read the owner sign-in when the audience was refused", async () => {
    const asked: Array<string | null | undefined> = [];
    provideGithubSignIn({
      token: async (audience) => {
        asked.push(audience);
        return audience === undefined || audience === null || audience === "owner" ? OWNER_SIGN_IN : null;
      },
      reportAuthFailure: () => {},
      signedIn: () => true,
    });
    expect(await githubToken(null)).toBe(OWNER_SIGN_IN);
    asked.length = 0;
    expect(await skillImportToken(null)).toEqual({ token: null });
    expect(asked).toEqual([]);
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const recorded = recordingFetch(github.fetch);
    ok(await fetchSkillFromSource("a/b", recorded.fetch, undefined, () => skillImportToken(null)));
    expect(recorded.calls.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(JSON.stringify(recorded.calls)).not.toContain(OWNER_SIGN_IN);
    expect(asked).toEqual([]);
  });

  it("uses the server sign-in when the caller does not pass a getter", async () => {
    provideGithubSignIn({ token: async () => SIGNED_IN, reportAuthFailure: () => {}, signedIn: () => true });
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const recorded = recordingFetch(github.fetch);
    ok(await fetchSkillFromSource("a/b", recorded.fetch));
    const api = apiCalls(recorded.calls);
    const raw = rawCalls(recorded.calls);
    expect(api.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    expect(api.every((call) => call.headers.get("authorization") === `Bearer ${SIGNED_IN}`)).toBe(true);
    expect(raw.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(recorded.calls.every((call) => !call.url.includes(SIGNED_IN))).toBe(true);
  });

  it("records HEAD for a link that names no branch, so updates follow the default branch", async () => {
    const github = fakeGitHub({ "a/b": { "SKILL.md": SKILL("root-skill"), "notes/a.md": "a" } });
    const [skill] = ok(await fetchSkillFromSource("a/b", github.fetch));
    expect(skill!.github).toEqual({ owner: "a", repo: "b", ref: "HEAD", commit: github.commitOf("a/b"), path: "" });
    expect(skill!.files.map((file) => file.path)).toEqual(["SKILL.md", "notes/a.md"]);
    expect(github.requests[0]).toBe("https://api.github.com/repos/a/b/commits/HEAD");
  });

  it("leaves out links, submodules, dot and cache folders, LFS pointers and what does not fit, and says why", async () => {
    const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345678\n";
    const github = fakeGitHub({
      "a/b": {
        "s/SKILL.md": SKILL("tidy"),
        "s/link.md": { link: "../../etc/passwd" },
        "s/vendor": { submodule: true },
        "s/.github/workflows/ci.yml": "on: push\n",
        "s/.env": "TOKEN=1\n",
        "s/scripts/__pycache__/x.cpython-312.pyc": "bytecode",
        "s/node_modules/left-pad/index.js": "module.exports = 1;\n",
        "s/video.mp4": Buffer.alloc(SKILL_FOLDER_LIMITS.fileBytes + 1),
        "s/model.bin": lfs,
        "s/CON.md": "device name\n",
        "s/notes.": "trailing dot\n",
        "s/README.md": "upper\n",
        "s/readme.md": "lower\n",
        "s/1/2/3/4/5/6/7/8.md": "fits\n",
        "s/1/2/3/4/5/6/7/8/9.md": "too deep\n",
      },
    });
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/s", github.fetch));
    expect(skill!.files.map((file) => file.path).sort()).toEqual(["1/2/3/4/5/6/7/8.md", "README.md", "SKILL.md"]);
    expect(Object.fromEntries(skill!.skipped.map((entry) => [entry.path, entry.reason]))).toEqual({
      ".env": "hidden",
      ".github/": "hidden",
      "node_modules/": "generated",
      "link.md": "link",
      "vendor": "submodule",
      "CON.md": "name",
      "notes.": "name",
      "readme.md": "duplicate",
      "video.mp4": "large",
      "scripts/__pycache__/": "generated",
      "1/2/3/4/5/6/7/8/": "deep",
      "model.bin": "lfs",
    });
    const downloaded = github.requests.filter((url) => url.startsWith("https://raw.githubusercontent.com/"));
    for (const never of ["link.md", ".env", "ci.yml", "index.js", "video.mp4", "CON.md", "readme.md", "9.md", ".pyc"]) {
      expect(downloaded.some((url) => url.includes(never)), never).toBe(false);
    }
  });

  it("stops at the folder's file limit and names what it left out", async () => {
    const entries: Record<string, FakeRepoEntry> = { "s/SKILL.md": SKILL("many") };
    for (let i = 0; i < SKILL_FOLDER_LIMITS.files + 4; i++) entries[`s/refs/f${String(i).padStart(3, "0")}.md`] = `${i}\n`;
    const github = fakeGitHub({ "a/b": entries });
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/s", github.fetch));
    expect(skill!.files).toHaveLength(SKILL_FOLDER_LIMITS.files);
    expect(skill!.skipped).toHaveLength(5);
    expect(skill!.skipped.every((entry) => entry.reason === "full")).toBe(true);
  });

  it("stops at the folder's size limit", async () => {
    const big = Buffer.alloc(SKILL_FOLDER_LIMITS.fileBytes, 1);
    const entries: Record<string, FakeRepoEntry> = { "s/SKILL.md": SKILL("heavy") };
    const fit = Math.floor(SKILL_FOLDER_LIMITS.bytes / big.length) - 1;
    for (let i = 0; i < fit + 2; i++) entries[`s/assets/a${i}.bin`] = big;
    const github = fakeGitHub({ "a/b": entries });
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/s", github.fetch));
    expect(skill!.files).toHaveLength(fit + 1);
    expect(skill!.skipped.map((entry) => entry.reason)).toEqual(["full", "full"]);
  });

  it("refuses a file whose bytes are not the ones the commit names", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL }, { tamper: ["skills/pdf/scripts/fill.py"] });
    expect(await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", github.fetch))
      .toEqual({ error: expect.stringContaining("scripts/fill.py does not match commit") });
  });

  it("brings the whole folder for a link straight to a SKILL.md", async () => {
    for (const link of [
      "https://github.com/a/b/blob/main/skills/pdf/SKILL.md",
      "https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md",
      "https://raw.githubusercontent.com/a/b/refs/heads/main/skills/pdf/SKILL.md",
    ]) {
      const github = fakeGitHub({ "a/b": PDF_SKILL });
      const [skill] = ok(await fetchSkillFromSource(link, github.fetch));
      expect(skill!.files, link).toHaveLength(7);
      expect(skill!.github, link).toMatchObject({ ref: "main", path: "skills/pdf" });
    }
  });

  it("falls back to SKILL.md alone, said so, when GitHub will not list a linked SKILL.md's folder", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL }, { rateLimited: true });
    const link = "https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md";
    const [skill] = ok(await fetchSkillFromSource(link, github.fetch));
    expect(skill).toEqual({
      source: link,
      files: [{ path: "SKILL.md", content: Buffer.from(SKILL("pdf")), executable: false }],
      skipped: [{ path: "", reason: "unlisted" }],
    });
    expect(await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", github.fetch))
      .toEqual({ error: expect.stringContaining("API rate limit was reached") });
  });

  it.each([
    "https://github.com/a/b/tree/main/skills/../../../user",
    "https://github.com/a/b/tree/main/skills/%2e%2e/x",
    "https://github.com/a/b/tree/main/skills%2F..%2F..%2Fx",
    "https://github.com/a%3Fx/b/tree/main/skills",
  ])("refuses a pasted path that would climb out of the repository: %s", async (link) => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await fetchSkillFromSource(link, fetcher)).toEqual({ error: expect.stringContaining("does not look like") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ignores a query or fragment pasted with a GitHub link", () => {
    expect(parseSkillSource("https://github.com/a/b/tree/main/skills/pdf?tab=readme#usage")).toEqual({ owner: "a", repo: "b", ref: "main", path: "skills/pdf" });
  });

  it("finds the commit a skill's link names now, and the link that imports it again", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const [skill] = ok(await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", github.fetch));
    const recorded = recordingFetch(github.fetch);
    expect(await latestSkillCommit(skill!.github!, recorded.fetch, async () => ({ token: SIGNED_IN }))).toBe(github.commitOf("a/b"));
    const lookups = recorded.calls.filter((call) => call.url.includes("/commits/"));
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((call) => call.headers.get("authorization") === `Bearer ${SIGNED_IN}` && call.headers.get("accept") === "application/vnd.github.sha")).toBe(true);
    const again = ok(await fetchSkillFromSource(githubSkillLink(skill!.github!), github.fetch));
    expect(again[0]!.github).toEqual(skill!.github);
    expect(await latestSkillCommit({ ...skill!.github!, repo: "gone" }, github.fetch)).toEqual({ error: expect.stringContaining("404") });
  });
});

describe("skill import budget", () => {
  it("imports a complete 30-skill collection without unbounded parallel downloads", async () => {
    const entries: Record<string, FakeRepoEntry> = {};
    for (let i = 0; i < 30; i++) Object.assign(entries, { [`skills/skill-${i}/SKILL.md`]: SKILL(`skill-${i}`), [`skills/skill-${i}/help.md`]: "# Help" });
    const github = fakeGitHub({ "a/b": entries });
    let active = 0;
    let peak = 0;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith("https://raw.githubusercontent.com/")) return github.fetch(input, init);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return github.fetch(input, init);
    }) as typeof fetch;
    const skills = ok(await fetchSkillFromSource("a/b", fetcher));
    expect(skills).toHaveLength(30);
    expect(skills.every((skill) => skill.files.length === 2)).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("caps the entire directory walk rather than multiplying per-directory caps", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/commits/")) return new Response("c".repeat(40));
      const path = new URL(String(input)).pathname.split("/contents/")[1] ?? "";
      return Response.json(Array.from({ length: 60 }, (_, i) => ({ type: "dir", name: `folder-${i}`, path: `${path ? `${path}/` : ""}folder-${i}` })));
    }) as typeof fetch;
    const result = await fetchSkillFromSource("a/b", fetcher);
    expect(result).toEqual({ error: expect.stringContaining("request limit") });
    expect(fetcher).toHaveBeenCalledTimes(128);
  });

  it("stops reading an oversized file before buffering the whole download", async () => {
    const github = fakeGitHub({ "a/b": { "SKILL.md": SKILL("huge") } });
    const cancelled = vi.fn();
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith("https://raw.githubusercontent.com/")) return github.fetch(input, init);
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
        cancel: cancelled,
      }));
    }) as typeof fetch;
    expect(await fetchSkillFromSource("a/b", fetcher)).toEqual({ error: expect.stringContaining("size limit") });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("refuses a SKILL.md over its own limit without downloading it", async () => {
    const github = fakeGitHub({ "a/b": { "SKILL.md": `${SKILL("long")}${"x".repeat(300 * 1024)}` } });
    expect(await fetchSkillFromSource("a/b", github.fetch)).toEqual({ error: expect.stringContaining("SKILL.md is larger than 256KB") });
    expect(github.requests.some((url) => url.startsWith("https://raw.githubusercontent.com/"))).toBe(false);
  });
});

describe("skill fetch host pinning", () => {
  it.each([
    "https://evil.example.com/a/b/main/SKILL.md",
    "http://raw.githubusercontent.com/a/b/main/SKILL.md",
    "https://raw.githubusercontent.com:8443/a/b/main/SKILL.md",
    "https://user:pass@raw.githubusercontent.com/a/b/main/SKILL.md",
  ])("refuses a download_url that leaves the pinned raw host: %s", async (download_url) => {
    const github = fakeGitHub({ "a/b": { "skills/search-helper/SKILL.md": "---\nname: Wanted Skill\ndescription: d\n---\n" } });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await github.fetch(input, init);
      if (!String(input).endsWith("/contents/skills/search-helper?ref=" + github.commitOf("a/b"))) return response;
      return Response.json([{ type: "file", name: "SKILL.md", path: "skills/search-helper/SKILL.md", download_url }]);
    }) as typeof fetch;
    const [skill] = ok(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", fetcher));
    expect(skill!.source).toBe("github.com/a/b/skills/search-helper");
    expect(vi.mocked(fetcher).mock.calls.map(([input]) => String(input))).not.toContain(download_url);
  });

  it("does not fetch a Contents API download_url, even one with a temporary token", async () => {
    const skillMd = "---\nname: Find Skills\ndescription: finds things\n---\n# A skill";
    const github = fakeGitHub({ "vercel-labs/skills": { "skills/search-helper/SKILL.md": skillMd } });
    const tokenized = `https://raw.githubusercontent.com/vercel-labs/skills/${github.commitOf("vercel-labs/skills")}/skills/search-helper/SKILL.md?token=v1.private-file-token`;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await github.fetch(input, init);
      if (!String(input).includes("/contents/skills/search-helper?ref=")) return response;
      return Response.json([{
        type: "file",
        name: "SKILL.md",
        path: "skills/search-helper/SKILL.md",
        download_url: tokenized,
      }]);
    }) as typeof fetch;
    const recorded = recordingFetch(fetcher);
    const [skill] = ok(await fetchSkillFromSource(
      "https://skills.sh/vercel-labs/skills/find-skills",
      recorded.fetch,
      undefined,
      async () => ({ token: SIGNED_IN }),
    ));
    expect(skill!.source).toBe("github.com/vercel-labs/skills/skills/search-helper");
    const urls = recorded.calls.map((call) => call.url);
    expect(urls).not.toContain(tokenized);
    expect(urls.every((url) => !url.includes("token="))).toBe(true);
    expect(rawCalls(recorded.calls).every((call) => call.headers.get("authorization") === null && !call.url.includes("?"))).toBe(true);
    expect(JSON.stringify(urls)).not.toContain("v1.private-file-token");
  });

  it("refuses a pasted plain-http raw link without fetching it", async () => {
    const fetcher = vi.fn(async () => new Response("# A skill")) as typeof fetch;
    expect(await fetchSkillFromSource("http://raw.githubusercontent.com/a/b/main/SKILL.md", fetcher))
      .toEqual({ error: expect.stringContaining("instead of plain http") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a raw download that redirects off GitHub instead of following it", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const offhost = "https://evil.example.com/SKILL.md";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === offhost) return new Response("# evil");
      if (!url.startsWith("https://raw.githubusercontent.com/")) return github.fetch(input, init);
      // Like the platform fetch: redirect "error" refuses, anything else follows the 302 to offhost.
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      return fetcher(offhost, init);
    }) as typeof fetch;
    const result = await fetchSkillFromSource("https://github.com/a/b/tree/main/skills/pdf", fetcher);
    expect("skills" in result).toBe(false);
    expect(vi.mocked(fetcher).mock.calls.map(([input]) => String(input))).not.toContain(offhost);
  });

  it("does not follow an API redirect off api.github.com when the request carries a sign-in", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const offhost = "https://evil.example.com/repos/a/b/commits/HEAD";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === offhost) return new Response("relocated");
      if (url.startsWith("https://api.github.com/") && url.includes("/commits/")) {
        // Like the platform fetch: redirect "manual" hands back the 302, anything else follows it off-origin.
        if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: offhost } });
        return fetcher(offhost, init);
      }
      return github.fetch(input, init);
    }) as typeof fetch;
    const result = await fetchSkillFromSource("a/b", fetcher, undefined, async () => ({ token: SIGNED_IN }));
    const urls = vi.mocked(fetcher).mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.startsWith("https://api.github.com/") && url.includes("/commits/"))).toBe(true);
    expect(urls).not.toContain(offhost);
    expect(result).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(SIGNED_IN);
    const api = vi.mocked(fetcher).mock.calls.find(([input]) => String(input).includes("/commits/"));
    expect(new Headers(api?.[1]?.headers).get("authorization")).toBe(`Bearer ${SIGNED_IN}`);
    expect(api?.[1]?.redirect).toBe("manual");
  });

  it("follows a renamed repository's API redirect within api.github.com, still signed in", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const moved = "https://api.github.com/repositories/70107786";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/repos/old/b/")) {
        return new Response(null, { status: 301, headers: { location: url.replace("https://api.github.com/repos/old/b", moved) } });
      }
      if (url.startsWith(`${moved}/`)) return github.fetch(url.replace(moved, "https://api.github.com/repos/a/b"), init);
      return github.fetch(input, init);
    }) as typeof fetch;
    expect(await latestSkillCommit({ owner: "old", repo: "b", ref: "HEAD", commit: "", path: "" }, fetcher, async () => ({ token: SIGNED_IN })))
      .toBe(github.commitOf("a/b"));
    const followed = vi.mocked(fetcher).mock.calls.find(([input]) => String(input).startsWith(`${moved}/`));
    expect(followed).toBeDefined();
    expect(new Headers(followed?.[1]?.headers).get("authorization")).toBe(`Bearer ${SIGNED_IN}`);
    expect(followed?.[1]?.redirect).toBe("manual");
  });

  it("leaves a sign-in that cannot be a header out of the error", async () => {
    const credential = "gho_not\r\na header";
    const refused: string[] = [];
    const fetcher = vi.fn(async () => new Response("no", { status: 401 })) as typeof fetch;
    const result = await fetchSkillFromSource("owner/repo", fetcher, undefined, async () => ({ token: credential, refused: () => { refused.push(credential); } }));
    expect(result).toEqual({ error: expect.stringContaining("401") });
    expect(JSON.stringify(result)).not.toContain("gho_not");
    expect(new Headers(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
    expect(refused).toEqual([]);
  });

  it("reports one refused API request for the audience whose token was sent", async () => {
    const member = "p_adaaaaaaaaaaaaaaaaaaaaa";
    const refused: Array<string | null | undefined> = [];
    const asked: Array<string | null | undefined> = [];
    provideGithubSignIn({
      token: async (audience) => { asked.push(audience); return audience === member ? SIGNED_IN : null; },
      reportAuthFailure: (audience) => { refused.push(audience); },
      signedIn: () => true,
    });
    const fetcher = vi.fn(async () => new Response("no", { status: 401 })) as typeof fetch;
    const result = await fetchSkillFromSource("owner/repo", fetcher, undefined, () => skillImportToken(member));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: expect.stringContaining("401") });
    expect(JSON.stringify(result)).not.toContain(SIGNED_IN);
    expect(new Headers(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${SIGNED_IN}`);
    expect(asked).toEqual([member]);
    expect(refused).toEqual([member]);
  });

  it("reports the server sign-in when its own API request is refused", async () => {
    const refused: Array<string | null | undefined> = [];
    provideGithubSignIn({
      token: async () => SIGNED_IN,
      reportAuthFailure: (audience) => { refused.push(audience); },
      signedIn: () => true,
    });
    const fetcher = vi.fn(async () => new Response("no", { status: 401 })) as typeof fetch;
    const result = await fetchSkillFromSource("owner/repo", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: expect.stringContaining("401") });
    expect(JSON.stringify(result)).not.toContain(SIGNED_IN);
    expect(refused).toEqual(["owner"]);
  });

  it("does not report an anonymous API refusal", async () => {
    const refused: Array<string | null | undefined> = [];
    const asked: Array<string | null | undefined> = [];
    provideGithubSignIn({
      token: async (audience) => { asked.push(audience); return OWNER_SIGN_IN; },
      reportAuthFailure: (audience) => { refused.push(audience); },
      signedIn: () => true,
    });
    const fetcher = vi.fn(async () => new Response("no", { status: 401 })) as typeof fetch;
    const result = await fetchSkillFromSource("owner/repo", fetcher, undefined, () => skillImportToken(null));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: expect.stringContaining("401") });
    expect(new Headers(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
    expect(asked).toEqual([]);
    expect(refused).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(OWNER_SIGN_IN);
  });

  it("downloads only from the pinned raw host, with redirects refused", async () => {
    const github = fakeGitHub({ "a/b": PDF_SKILL });
    const fetcher = vi.fn(github.fetch) as typeof fetch;
    ok(await fetchSkillFromSource("https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md", fetcher));
    const calls = vi.mocked(fetcher).mock.calls;
    for (const [input, init] of calls) {
      const host = new URL(String(input)).hostname;
      expect(["api.github.com", "raw.githubusercontent.com"]).toContain(host);
      if (host === "raw.githubusercontent.com") expect(init).toMatchObject({ redirect: "error" });
    }
  });
});

describe("skill sources", () => {
  it.each(["https://skills.sh/a/b/...", "https://skills.sh/a/b/---", "https://skills.sh/../b/skill"])(
    "refuses invalid skills.sh paths instead of importing every skill: %s", async (source) => {
      const fetcher = vi.fn() as unknown as typeof fetch;
      expect(await fetchSkillFromSource(source, fetcher)).toEqual({ error: expect.stringContaining("does not look like") });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["https://github.com/a/b/blob/main/SKILL.md", ""],
    ["https://github.com/a/b/blob/main/skills/pdf/SKILL.md", "skills/pdf"],
  ])("reads a GitHub blob link to a SKILL.md as its folder: %s", (source, path) => {
    expect(parseSkillSource(source)).toEqual({
      owner: "a", repo: "b", ref: "main", path,
      rawUrl: `https://raw.githubusercontent.com/a/b/main/${path ? `${path}/` : ""}SKILL.md`,
    });
  });

  it.each([
    "https://github.com/a/b/blob/main/README-SKILL.md",
    "https://github.com/a/b/blob/main/docs/notSKILL.md",
  ])("refuses a blob link to a file that is not SKILL.md, like a raw link does: %s", async (source) => {
    const fetcher = vi.fn(async () => new Response("# Not a skill")) as typeof fetch;
    expect(await fetchSkillFromSource(source, fetcher)).toEqual({ error: expect.stringContaining("does not look like") });
    expect(await fetchSkillFromSource(source.replace("github.com/a/b/blob/", "raw.githubusercontent.com/a/b/"), fetcher))
      .toEqual({ error: expect.stringContaining("does not look like") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("imports just the named skill from a skills.sh page", async () => {
    const github = fakeGitHub({ "vercel-labs/skills": {
      "skills/pdf/SKILL.md": SKILL("pdf"),
      "skills/find-skills/SKILL.md": SKILL("find-skills"),
      "skills/find-skills/references/how.md": "# How\n",
    } });
    const skills = ok(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", github.fetch));
    expect(skills.map((skill) => [skill.source, skill.files.map((file) => file.path)])).toEqual([
      ["github.com/vercel-labs/skills/skills/find-skills", ["SKILL.md", "references/how.md"]],
    ]);
  });

  it("names the missing skill when a skills.sh page does not match anything", async () => {
    const github = fakeGitHub({ "vercel-labs/skills": { "skills/pdf/SKILL.md": SKILL("pdf") } });
    expect(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/nope", github.fetch))
      .toEqual({ error: expect.stringContaining('no skill named "nope"') });
  });

  it("matches a skills.sh slug against the SKILL.md name when the folder differs", async () => {
    const skillMd = "---\nname: Find Skills\ndescription: finds things\n---\n# A skill";
    const github = fakeGitHub({ "vercel-labs/skills": { "skills/search-helper/SKILL.md": skillMd } });
    const [skill] = ok(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", github.fetch));
    expect(skill!.source).toBe("github.com/vercel-labs/skills/skills/search-helper");
    expect(skill!.files).toEqual([{ path: "SKILL.md", content: Buffer.from(skillMd), executable: false }]);
  });

  it("skips a root SKILL.md that is not the requested skills.sh skill", async () => {
    const github = fakeGitHub({ "a/b": { "SKILL.md": "---\nname: Something Else\n---\n# root skill", "docs/notes.md": "notes" } });
    expect(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", github.fetch))
      .toEqual({ error: expect.stringContaining('no skill named "wanted-skill"') });
  });

  it("imports a root SKILL.md whose name matches the requested skills.sh skill", async () => {
    const github = fakeGitHub({ "a/b": { "SKILL.md": "---\nname: Wanted Skill\n---\n# root skill" } });
    const [skill] = ok(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", github.fetch));
    expect(skill).toMatchObject({ source: "github.com/a/b", github: { path: "" } });
  });

  it("finds the requested skill even past the first 60 child folders", async () => {
    const entries: Record<string, FakeRepoEntry> = { "skills/find-skills/SKILL.md": SKILL("find-skills") };
    for (let i = 0; i < 60; i++) entries[`skills/filler-${String(i).padStart(2, "0")}/README.md`] = "filler";
    const github = fakeGitHub({ "vercel-labs/skills": entries });
    const [skill] = ok(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", github.fetch));
    expect(skill!.source).toBe("github.com/vercel-labs/skills/skills/find-skills");
  });
});
