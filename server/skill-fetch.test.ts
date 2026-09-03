import { describe, expect, it } from "vitest";

import { fetchSkillFromSource, parseSkillImportInput, parseSkillSource } from "./skill-fetch.ts";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\nUse it safely.\n`;

function fakeGitHub(listings: ReadonlyMap<string, unknown>, files: ReadonlyMap<string, string> = new Map()) {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (files.has(url)) return new Response(files.get(url), { status: 200 });
    const listing = listings.get(url);
    return new Response(listing === undefined ? "not found" : JSON.stringify(listing), {
      status: listing === undefined ? 404 : 200,
    });
  };
  return { fetcher, requested };
}

describe("parseSkillImportInput", () => {
  it("treats the exact npx add form as data", () => {
    expect(parseSkillImportInput("npx skills add owner/repo --skill code-review")).toEqual({
      source: "owner/repo",
      skillName: "code-review",
    });
    expect(parseSkillImportInput('npx skills add "https://github.com/owner/repo" -s code-review')).toEqual({
      source: "https://github.com/owner/repo",
      skillName: "code-review",
    });
    expect(parseSkillImportInput("owner/repo")).toEqual({ source: "owner/repo" });
  });

  it("rejects command variants, extra arguments, unsafe selectors, and malformed quoting", () => {
    for (const input of [
      "skills add owner/repo --skill code-review",
      "npx --yes skills add owner/repo --skill code-review",
      "npx skills remove owner/repo --skill code-review",
      "npx skills add owner/repo",
      "npx skills add owner/repo --force --skill code-review",
      "npx skills add owner/repo --skill bad_name",
      "npx skills add owner/repo --skill one --skill two",
      "npx skills add owner/repo --skill code-review && calc",
      'npx skills add "owner/repo --skill code-review',
    ]) {
      expect(parseSkillImportInput(input), input).toMatchObject({ error: expect.any(String) });
    }
  });
});

describe("GitHub skill source parsing", () => {
  it("normalizes only the allowed tracking query", () => {
    expect(parseSkillSource("https://github.com/owner/repo?ysclid=tracking-value")).toMatchObject({
      owner: "owner",
      repo: "repo",
      path: "",
    });
    expect(parseSkillSource("https://github.com/owner/repo?tab=readme")).toMatchObject({ error: expect.any(String) });
    expect(parseSkillSource("https://github.com/owner/repo?ysclid=x#readme")).toMatchObject({ error: expect.any(String) });
  });

  it("accepts direct nested skill manifests", () => {
    expect(parseSkillSource("https://github.com/o/r/blob/main/skills/alpha/SKILL.md")).toEqual({
      rawUrl: "https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md",
    });
    expect(parseSkillSource("https://github.com/o/r/blob/main/.agents/skills/beta/SKILL.md")).toEqual({
      rawUrl: "https://raw.githubusercontent.com/o/r/main/.agents/skills/beta/SKILL.md",
    });
  });

  it("rejects an insecure direct raw manifest before fetching", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return new Response(SKILL("unsafe"), { status: 200 });
    };
    await expect(
      fetchSkillFromSource("http://raw.githubusercontent.com/o/r/main/skills/unsafe/SKILL.md", fetcher),
    ).resolves.toMatchObject({ error: expect.any(String) });
    expect(requests).toBe(0);
  });

  it("stops an oversized raw manifest while streaming and disables redirects", async () => {
    let redirect: "error" | "follow" | "manual" | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      redirect = init?.redirect;
      const chunk = new Uint8Array(128 * 1024);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }), { status: 200 });
    };
    await expect(fetchSkillFromSource(
      "https://raw.githubusercontent.com/o/r/main/skills/large/SKILL.md",
      fetcher,
    )).resolves.toEqual({ error: "file is larger than the 256KB import cap" });
    expect(redirect).toBe("error");
  });
});

describe("fetchSkillFromSource", () => {
  const rootUrl = "https://api.github.com/repos/owner/repo/contents/";
  const listings = new Map<string, unknown>([
    [
      rootUrl,
      [
        { type: "dir", name: "skills", path: "skills" },
        { type: "dir", name: ".agents", path: ".agents" },
      ],
    ],
    [
      "https://api.github.com/repos/owner/repo/contents/skills",
      [{ type: "dir", name: "alpha", path: "skills/alpha" }],
    ],
    [
      "https://api.github.com/repos/owner/repo/contents/skills/alpha",
      [{ type: "file", name: "SKILL.md", path: "skills/alpha/SKILL.md", download_url: "https://raw.githubusercontent.com/fixtures/repo/main/alpha/SKILL.md" }],
    ],
    [
      "https://api.github.com/repos/owner/repo/contents/.agents/skills",
      [{ type: "dir", name: "beta", path: ".agents/skills/beta" }],
    ],
    [
      "https://api.github.com/repos/owner/repo/contents/.agents/skills/beta",
      [{ type: "file", name: "SKILL.md", path: ".agents/skills/beta/SKILL.md", download_url: "https://raw.githubusercontent.com/fixtures/repo/main/beta/SKILL.md" }],
    ],
  ]);
  const files = new Map([
    ["https://raw.githubusercontent.com/fixtures/repo/main/alpha/SKILL.md", SKILL("alpha")],
    ["https://raw.githubusercontent.com/fixtures/repo/main/beta/SKILL.md", SKILL("beta")],
  ]);

  it("discovers skills/<name> and .agents/skills/<name> with local fixtures", async () => {
    const { fetcher } = fakeGitHub(listings, files);
    await expect(fetchSkillFromSource("https://github.com/owner/repo?ysclid=tracking", fetcher)).resolves.toMatchObject({
      skills: [
        { source: "github.com/owner/repo/skills/alpha", files: [{ path: "SKILL.md", content: SKILL("alpha") }] },
        { source: "github.com/owner/repo/.agents/skills/beta", files: [{ path: "SKILL.md", content: SKILL("beta") }] },
      ],
    });
  });

  it("returns exactly the manifest named by --skill", async () => {
    const { fetcher } = fakeGitHub(listings, files);
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill beta", fetcher)).resolves.toEqual({
      skills: [{ source: "github.com/owner/repo/.agents/skills/beta", files: [{ path: "SKILL.md", content: SKILL("beta") }] }],
    });
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill missing", fetcher)).resolves.toEqual({
      error: "requested skill not found: missing",
    });
  });

  it("matches a case-insensitive frontmatter Name key like the installer", async () => {
    const caseInsensitiveFiles = new Map(files);
    caseInsensitiveFiles.set(
      "https://raw.githubusercontent.com/fixtures/repo/main/beta/SKILL.md",
      "---\nName: beta\ndescription: case fixture\n---\n\nUse it safely.\n",
    );
    const { fetcher } = fakeGitHub(listings, caseInsensitiveFiles);

    await expect(fetchSkillFromSource("npx skills add owner/repo --skill beta", fetcher)).resolves.toMatchObject({
      skills: [{ source: "github.com/owner/repo/.agents/skills/beta" }],
    });
  });

  it("uses the last duplicate name field like the installer", async () => {
    const installerSemanticsFiles = new Map(files);
    installerSemanticsFiles.set(
      "https://raw.githubusercontent.com/fixtures/repo/main/beta/SKILL.md",
      "---\nname: first-name\nName: beta\ndescription: duplicate fixture\n---\n\nUse it safely.\n",
    );
    const { fetcher } = fakeGitHub(listings, installerSemanticsFiles);

    await expect(fetchSkillFromSource("npx skills add owner/repo --skill beta", fetcher)).resolves.toMatchObject({
      skills: [{ source: "github.com/owner/repo/.agents/skills/beta" }],
    });
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill first-name", fetcher)).resolves.toEqual({
      error: "requested skill not found: first-name",
    });
  });

  it("continues explicit selector discovery beyond bounded non-selector caps", async () => {
    const children = Array.from({ length: 21 }, (_, index) => {
      const name = `skill-${String(index).padStart(2, "0")}`;
      return { type: "dir", name, path: `skills/${name}` };
    });
    const listings = new Map<string, unknown>([
      [rootUrl, [{ type: "dir", name: "skills", path: "skills" }]],
      ["https://api.github.com/repos/owner/repo/contents/skills", children],
      ...children.map((child): [string, unknown] => [
        `https://api.github.com/repos/owner/repo/contents/${child.path}`,
        [{ type: "file", name: "SKILL.md", path: `${child.path}/SKILL.md`, download_url: `https://raw.githubusercontent.com/fixtures/repo/main/${child.name}/SKILL.md` }],
      ]),
    ]);
    const files = new Map(
      children.map((child) => [
        `https://raw.githubusercontent.com/fixtures/repo/main/${child.name}/SKILL.md`,
        SKILL(child.name === "skill-20" ? "target-skill" : child.name),
      ]),
    );

    const selected = fakeGitHub(listings, files);
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill target-skill", selected.fetcher)).resolves.toEqual({
      skills: [{
        source: "github.com/owner/repo/skills/skill-20",
        files: [{ path: "SKILL.md", content: SKILL("target-skill") }],
      }],
    });

    const bounded = fakeGitHub(listings, files);
    const discovered = await fetchSkillFromSource("owner/repo", bounded.fetcher);
    expect(discovered).toMatchObject({ skills: expect.any(Array) });
    if ("skills" in discovered) {
      expect(discovered.skills).toHaveLength(10);
      expect(discovered.skills.some((skill) => skill.files.some((file) => file.content.includes("target-skill")))).toBe(false);
    }
  });

  it("does not match a --skill selector against name text in the manifest body", async () => {
    const misleadingFiles = new Map(files);
    misleadingFiles.set(
      "https://raw.githubusercontent.com/fixtures/repo/main/beta/SKILL.md",
      `${SKILL("gamma")}\nBody example:\nname: beta\n`,
    );
    const { fetcher } = fakeGitHub(listings, misleadingFiles);
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill beta", fetcher)).resolves.toEqual({
      error: "requested skill not found: beta",
    });
  });

  it("refuses a repository without a skill manifest clearly", async () => {
    const { fetcher, requested } = fakeGitHub(new Map([[rootUrl, []]]));
    await expect(fetchSkillFromSource("owner/repo", fetcher)).resolves.toEqual({
      error: "no SKILL.md skill manifest found — paste a skill folder or a repo with a skills/ directory",
    });
    expect(requested).toEqual([rootUrl]);
  });
});
