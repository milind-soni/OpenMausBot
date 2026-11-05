import { describe, expect, it, vi } from "vitest";

import { fetchSkillFromSource, githubSkillLink, latestSkillCommit, parseSkillSource } from "./skill-fetch.ts";
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

describe("importing a skill's whole folder", () => {
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
      .toEqual({ error: expect.stringContaining("limit for requests without sign-in") });
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
    expect(await latestSkillCommit(skill!.github!, github.fetch)).toBe(github.commitOf("a/b"));
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
    expect(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", fetcher))
      .toEqual({ error: expect.stringContaining('no skill named "wanted-skill"') });
    expect(vi.mocked(fetcher).mock.calls.map(([input]) => String(input))).not.toContain(download_url);
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
