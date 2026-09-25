import { describe, expect, it, vi } from "vitest";
import { fetchSkillFromSource } from "./skill-fetch.ts";

const file = (name: string) => ({ type: "file", name, path: name, download_url: `https://raw.githubusercontent.com/a/b/main/${name}` });
const dir = (path: string) => ({ type: "dir", name: path.split("/").at(-1), path });

describe("skill import budget", () => {
  it("imports a complete 30-skill collection without unbounded parallel downloads", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json(Array.from({ length: 30 }, (_, i) => dir(`skills/skill-${i}`)));
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md"), file("help.md")]);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response("# A skill");
    }) as typeof fetch;
    const result = await fetchSkillFromSource("a/b", fetcher);
    expect("skills" in result && result.skills).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("caps the entire directory walk rather than multiplying per-directory caps", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split("/contents/")[1] ?? "";
      return Response.json(Array.from({ length: 60 }, (_, i) => dir(`${path ? `${path}/` : ""}folder-${i}`)));
    }) as typeof fetch;
    const result = await fetchSkillFromSource("a/b", fetcher);
    expect(result).toEqual({ error: expect.stringContaining("request limit") });
    expect(fetcher).toHaveBeenCalledTimes(128);
  });

  it("stops reading an oversized file before buffering the whole download", async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
      cancel: cancelled,
    }))) as typeof fetch;
    expect(await fetchSkillFromSource("https://raw.githubusercontent.com/a/b/main/SKILL.md", fetcher))
      .toEqual({ error: expect.stringContaining("size limit") });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("skill sources", () => {
  it.each([
    ["https://github.com/a/b/blob/main/SKILL.md", "https://raw.githubusercontent.com/a/b/main/SKILL.md"],
    ["https://github.com/a/b/blob/main/skills/pdf/SKILL.md", "https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md"],
  ])("imports a GitHub blob link to a SKILL.md: %s", async (source, raw) => {
    const fetcher = vi.fn(async (_input: string | URL | Request) => new Response("# A skill")) as typeof fetch;
    expect(await fetchSkillFromSource(source, fetcher)).toEqual({
      skills: [{ source: raw, files: [{ path: "SKILL.md", content: "# A skill" }] }],
    });
    expect(vi.mocked(fetcher).mock.calls.map(([input]) => String(input))).toEqual([raw]);
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
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/pdf"), dir("skills/find-skills")]);
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response("# A skill");
    }) as typeof fetch;
    const result = await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", fetcher);
    expect(result).toEqual({
      skills: [{ source: "github.com/vercel-labs/skills/skills/find-skills", files: [{ path: "SKILL.md", content: "# A skill" }] }],
    });
  });

  it("names the missing skill when a skills.sh page does not match anything", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/pdf")]);
      return Response.json([file("SKILL.md")]);
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/nope", fetcher))
      .toEqual({ error: expect.stringContaining('no skill named "nope"') });
  });

  it("matches a skills.sh slug against the SKILL.md name when the folder differs", async () => {
    const skillMd = "---\nname: Find Skills\ndescription: finds things\n---\n# A skill";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/search-helper")]);
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response(skillMd);
    }) as typeof fetch;
    const result = await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", fetcher);
    expect(result).toEqual({
      skills: [{ source: "github.com/vercel-labs/skills/skills/search-helper", files: [{ path: "SKILL.md", content: skillMd }] }],
    });
  });

  it("skips a root SKILL.md that is not the requested skills.sh skill", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([file("SKILL.md"), dir("docs")]);
      if (url.endsWith("/contents/docs")) return Response.json([file("notes.md")]);
      return new Response("---\nname: Something Else\n---\n# root skill");
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", fetcher))
      .toEqual({ error: expect.stringContaining('no skill named "wanted-skill"') });
  });

  it("imports a root SKILL.md whose name matches the requested skills.sh skill", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([file("SKILL.md")]);
      return new Response("---\nname: Wanted Skill\n---\n# root skill");
    }) as typeof fetch;
    const result = await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", fetcher);
    expect(result).toMatchObject({ skills: [{ source: "github.com/a/b" }] });
  });

  it("finds the requested skill even past the first 60 child folders", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) {
        const filler = Array.from({ length: 60 }, (_, i) => dir(`skills/filler-${i}`));
        return Response.json([...filler, dir("skills/find-skills")]);
      }
      if (url.endsWith("/contents/skills/find-skills")) return Response.json([file("SKILL.md")]);
      if (url.includes("api.github.com")) return Response.json([file("README.md")]);
      return new Response("# A skill");
    }) as typeof fetch;
    const result = await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", fetcher);
    expect(result).toMatchObject({ skills: [{ source: "github.com/vercel-labs/skills/skills/find-skills" }] });
  });
});
