import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The versioned LLM-judge layer. The prompt is a committed, checksummed
 * artifact: a manifest pins every prompt file's sha256, the loader refuses
 * a mismatched or missing prompt, and verdict parsing is strict so a chatty
 * model cannot flatter a scenario into passing. */

const JUDGE_DIR = join(dirname(fileURLToPath(import.meta.url)));
export const PROMPTS_DIR = join(JUDGE_DIR, "prompts");

const manifestSchema = z.object({
  prompts: z.array(z.object({
    file: z.string(),
    version: z.string(),
    sha256: z.string().length(64),
  })).min(1),
});

export type JudgeManifest = z.infer<typeof manifestSchema>;

export function loadManifest(dir: string = PROMPTS_DIR): JudgeManifest {
  return manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
}

export function loadJudgePrompt(version: string, dir: string = PROMPTS_DIR): { version: string; text: string } {
  const manifest = loadManifest(dir);
  const entry = manifest.prompts.find((prompt) => prompt.version === version);
  if (entry === undefined) {
    throw new Error("no judge prompt version " + version + "; known: " + manifest.prompts.map((p) => p.version).join(", "));
  }
  const text = readFileSync(join(dir, entry.file), "utf8");
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (digest !== entry.sha256) {
    throw new Error("judge prompt " + entry.file + " does not match its manifest checksum; prompt files are versioned artifacts and must be bumped, not edited");
  }
  return { version, text };
}

export function renderJudgePrompt(template: string, task: string, reply: string): string {
  return template.replaceAll("{{task}}", task).replaceAll("{{reply}}", reply);
}

const verdictSchema = z.object({
  score: z.number().min(0).max(1),
  pass: z.boolean(),
  reasons: z.array(z.string()).max(5),
});

export type JudgeVerdict = z.infer<typeof verdictSchema>;

/** Extracts the first JSON object in the reply (tolerating code fences or
 * stray prose) and strictly validates it. */
export function parseJudgeVerdict(reply: string): JudgeVerdict {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], reply];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return verdictSchema.parse(JSON.parse(candidate.slice(start, end + 1)));
    } catch {
      // try the next candidate shape
    }
  }
  throw new Error("judge reply was not valid JSON matching the verdict contract");
}
