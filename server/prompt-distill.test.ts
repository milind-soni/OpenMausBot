import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearDistillCache, distillPrompt, distillPrompts, DISTILL_SYSTEM_PROMPT } from "./prompt-distill.ts";
import { PROMPT_PRESET_MAX_BYTES } from "./prompt-presets.ts";

const SOURCE = {
  id: "claude-fable",
  label: "Claude Fable 5.1",
  description: "Leaked Claude system prompt",
  text: "You are Claude, a large language model made by Anthropic. Be careful about safety. Use tools deliberately.",
  sourceUrl: "https://raw.githubusercontent.com/asgeirtj/system_prompts_leaks/main/Anthropic/claude-fable-5.1.md",
};

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "omb-distill-"));
  process.env.OMB_PROMPT_CACHE_DIR = cacheRoot;
});

afterEach(() => {
  delete process.env.OMB_PROMPT_CACHE_DIR;
});

describe("distillPrompt", () => {
  it("distills through the model call and returns a distilled preset", async () => {
    const prompts: string[] = [];
    const out = await distillPrompt(SOURCE, async (prompt) => {
      prompts.push(prompt);
      return "1. Reason before acting.\n2. State uncertainty plainly.\n";
    });
    expect(out.distilled).toBe(true);
    expect(out.text).toContain("Reason before acting");
    expect(out.sourceUrl).toBe(SOURCE.sourceUrl);
    expect(out.label).toBe(SOURCE.label);
    expect(prompts[0]).toContain("SYSTEM PROMPT START");
    expect(prompts[0]).toContain(SOURCE.text);
  });

  it("serves a second call from cache without invoking the model again", async () => {
    let calls = 0;
    const complete = async () => {
      calls++;
      return "1. distilled once";
    };
    const first = await distillPrompt(SOURCE, complete);
    const second = await distillPrompt({ ...SOURCE, label: "same content, different label" }, complete);
    expect(calls).toBe(1);
    expect(second.text).toBe(first.text);
    // The cache file exists and carries the distilled text.
    const files = (await import("node:fs")).readdirSync(cacheRoot);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("keys the cache on source content, not on preset identity", async () => {
    let calls = 0;
    const complete = async () => {
      calls++;
      return "1. distilled";
    };
    await distillPrompt(SOURCE, complete);
    await distillPrompt({ ...SOURCE, id: "other-id", text: `${SOURCE.text}\nDifferent content.` }, complete);
    expect(calls).toBe(2);
  });

  it("rejects an empty distillation with an error", async () => {
    await expect(distillPrompt(SOURCE, async () => "   ")).rejects.toThrow(/empty distillation/);
  });

  it("rejects output over the SOUL cap instead of truncating", async () => {
    const oversized = `1. word\n`.repeat(Math.ceil((PROMPT_PRESET_MAX_BYTES + 200) / 8));
    await expect(distillPrompt(SOURCE, async () => oversized)).rejects.toThrow(/SOUL cap/);
    // And the failed result was not cached.
    const again = await distillPrompt(SOURCE, async () => "1. fine now");
    expect(again.text).toBe("1. fine now");
  });
});

describe("distillPrompts", () => {
  it("distills a batch and preserves order", async () => {
    const out = await distillPrompts(
      [SOURCE, { ...SOURCE, id: "gpt", label: "ChatGPT 5.6" }],
      async () => "1. principle",
    );
    expect(out.presets.map((p) => p.id)).toEqual(["claude-fable", "gpt"]);
    expect(out.errors).toEqual([]);
  });

  it("turns one failure into one error line and keeps the rest", async () => {
    const out = await distillPrompts(
      [
        SOURCE,
        { ...SOURCE, id: "boom", label: "Broken one", text: "a prompt the fake engine refuses" },
      ],
      async (prompt) => {
        if (prompt.includes("refuses")) throw new Error("engine dead");
        return "1. fine";
      },
    );
    expect(out.presets.map((p) => p.id)).toEqual(["claude-fable"]);
    expect(out.errors).toEqual(["Broken one: engine dead"]);
  });

  it("caps a huge collection at 12 prompts with a notice", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...SOURCE, id: `p${i}`, label: `Prompt ${i}` }));
    const out = await distillPrompts(many, async () => "1. principle");
    expect(out.presets.length).toBe(12);
    expect(out.errors.join(" ")).toContain("first 12 of 20");
  });

  it("clears the cache so the next call re-distills", async () => {
    let calls = 0;
    const complete = async () => {
      calls++;
      return "1. principle";
    };
    await distillPrompt(SOURCE, complete);
    await clearDistillCache();
    await distillPrompt(SOURCE, complete);
    expect(calls).toBe(2);
  });
});

describe("DISTILL_SYSTEM_PROMPT", () => {
  it("demands vendor neutrality", () => {
    expect(DISTILL_SYSTEM_PROMPT).toMatch(/vendor-neutral/i);
  });
});
