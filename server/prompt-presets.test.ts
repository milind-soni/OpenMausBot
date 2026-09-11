// Prompt library: built-ins, GitHub source parsing, markdown→preset
// conversion, and the bounded import pipeline. All network goes through a
// fake fetch — no test touches the real GitHub.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_PRESETS,
  PROMPT_PRESET_MAX_BYTES,
  fetchPromptsFromSource,
  labelFromMarkdown,
  parsePromptSource,
  presetWire,
} from "./prompt-presets.ts";

afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200): Response => new Response(body, { status });

describe("built-in presets", () => {
  it("are original text under the SOUL cap with unique ids", () => {
    const ids = new Set<string>();
    for (const preset of BUILT_IN_PRESETS) {
      expect(Buffer.byteLength(preset.text, "utf8")).toBeLessThanOrEqual(PROMPT_PRESET_MAX_BYTES);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.source).toBe("built-in");
    }
    expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(6);
  });

  it("wire includes the source url for imported presets", () => {
    const wired = presetWire({ id: "x", label: "X", description: "d", text: "t", source: { url: "https://raw.githubusercontent.com/a/b/main/p.md" } });
    expect(wired.source).toBe("https://raw.githubusercontent.com/a/b/main/p.md");
    expect(presetWire(BUILT_IN_PRESETS[0]!).source).toBe("built-in");
  });
});

describe("parsePromptSource", () => {
  it("accepts owner/repo, tree URLs, and direct markdown files", () => {
    expect(parsePromptSource("asgeirtj/system_prompts_leaks")).toEqual({ owner: "asgeirtj", repo: "system_prompts_leaks", path: "" });
    expect(parsePromptSource("https://github.com/a/b/tree/main/prompts")).toEqual({ owner: "a", repo: "b", ref: "main", path: "prompts" });
    expect(parsePromptSource("https://github.com/a/b/blob/main/prompt.md")).toEqual({
      rawUrl: "https://raw.githubusercontent.com/a/b/main/prompt.md",
    });
    expect(parsePromptSource("https://raw.githubusercontent.com/a/b/main/prompt.txt")).toEqual({
      rawUrl: "https://raw.githubusercontent.com/a/b/main/prompt.txt",
    });
  });

  it("refuses non-GitHub hosts and gibberish", () => {
    expect(parsePromptSource("https://evil.example.com/a/b")).toHaveProperty("error");
    expect(parsePromptSource("https://gitlab.com/a/b")).toHaveProperty("error");
    expect(parsePromptSource("not a url at all!!")).toHaveProperty("error");
    expect(parsePromptSource("")).toHaveProperty("error");
  });
});

describe("labelFromMarkdown", () => {
  it("takes the label from the first H1 and the description from the first paragraph", () => {
    const { label, description } = labelFromMarkdown("some-file.md", "# Security Reviewer\n\nFinds real vulns, ignores style.\n\nMore text.");
    expect(label).toBe("Security Reviewer");
    expect(description).toBe("Finds real vulns, ignores style.");
  });

  it("falls back to the filename stem and stays bounded", () => {
    const { label, description } = labelFromMarkdown("prompt-engineering.md", "no headings here");
    expect(label).toBe("prompt engineering");
    expect(description).toBe("no headings here");
    const long = labelFromMarkdown("x.md", "# " + "t".repeat(200));
    expect(long.label.length).toBeLessThanOrEqual(80);
  });
});

describe("fetchPromptsFromSource", () => {
  const listing = json([
    { type: "file", name: "reviewer.md", path: "reviewer.md", download_url: "https://raw.githubusercontent.com/a/b/main/reviewer.md" },
    { type: "file", name: "giant.md", path: "giant.md", download_url: "https://raw.githubusercontent.com/a/b/main/giant.md" },
    { type: "file", name: "notes.txt", path: "notes.txt", download_url: "https://raw.githubusercontent.com/a/b/main/notes.txt" },
    { type: "dir", name: "sub", path: "sub" },
  ]);

  const fakeFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/contents/")) return listing.clone();
    if (url.endsWith("giant.md")) return text("x".repeat(PROMPT_PRESET_MAX_BYTES + 1));
    if (url.endsWith("reviewer.md")) return text("# Reviewer\n\nFinds real defects.\n\nBody.");
    return text("Plain note prompt.");
  });

  it("imports markdown files as presets and reports skipped ones without failing", async () => {
    const fetched = await fetchPromptsFromSource("a/b", fakeFetch as unknown as typeof fetch);
    expect(fetched).not.toHaveProperty("error");
    if (!("presets" in fetched)) return;
    expect(fetched.presets).toHaveLength(2);
    expect(fetched.presets[0]).toMatchObject({ label: "Reviewer", sourceUrl: "https://raw.githubusercontent.com/a/b/main/reviewer.md" });
    expect(fetched.presets[0].text).toContain("Finds real defects.");
    expect(fetched.errors.join(" ")).toContain("giant.md");
    // only api.github.com and raw.githubusercontent.com are ever contacted
    for (const call of fakeFetch.mock.calls) expect(String(call[0])).toMatch(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//);
  });

  it("rejects oversized prompts instead of truncating them", async () => {
    const giantOnly = json([
      { type: "file", name: "giant.md", path: "giant.md", download_url: "https://raw.githubusercontent.com/a/b/main/giant.md" },
    ]);
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/contents/")) return giantOnly;
      return text("x".repeat(PROMPT_PRESET_MAX_BYTES + 1));
    });
    const fetched = await fetchPromptsFromSource("a/b", fetcher as unknown as typeof fetch);
    expect(fetched).toHaveProperty("error");
    expect((fetched as { error: string }).error).toContain("24000");
  });

  it("passes through parse errors and caps file counts", async () => {
    expect(await fetchPromptsFromSource("not a url", fetch)).toHaveProperty("error");
    const many = Array.from({ length: 40 }, (_, i) => ({
      type: "file", name: `p${i}.md`, path: `p${i}.md`, download_url: `https://raw.githubusercontent.com/a/b/main/p${i}.md`,
    }));
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/contents/")) return json(many);
      return text("# P\n\nPrompt body.");
    });
    const fetched = await fetchPromptsFromSource("a/b", fetcher as unknown as typeof fetch);
    if ("presets" in fetched) expect(fetched.presets).toHaveLength(30);
  });
});
