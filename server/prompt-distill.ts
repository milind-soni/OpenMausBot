// Meta-prompt distillation: turn a leaked vendor system prompt from the
// community collection (asgeirtj/system_prompts_leaks) into a short,
// vendor-neutral set of operating principles any bot can wear as SOUL.
// The model itself does the reducing; the result is cached on disk keyed by
// the source content's SHA-256, so a prompt is distilled once and re-served
// forever after. Oversized output is an error, never a truncation — a
// silently cut system prompt is a bug.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { META_SOURCE_PREFIX, PROMPT_PRESET_MAX_BYTES } from "./prompt-presets.ts";

export { META_SOURCE_PREFIX };

export const DISTILL_SYSTEM_PROMPT = [
  "You reduce a leaked AI system prompt into a compact, vendor-neutral operating principles document.",
  "Rules:",
  "- Extract the techniques that make the prompt effective: reasoning discipline, tool-use policy, tone, safety posture, output structure.",
  "- Write them as imperative principles an assistant of any kind could follow. No vendor, product, or model names; no tool names that do not transfer.",
  "- Merge duplicates; drop trivia, formatting quirks, and anything tied to that vendor's specific surfaces.",
  "- Plain markdown, no headings deeper than ###, at most ~1200 words.",
  "- Output only the distilled principles.",
].join(" ");

/** The model call the distiller needs: one completion in, one text out. */
export type DistillComplete = (prompt: string) => Promise<string>;

export interface DistilledPrompt {
  id: string;
  label: string;
  description: string;
  text: string;
  sourceUrl: string;
  distilled: true;
}

export interface DistillOutcome {
  presets: DistilledPrompt[];
  errors: string[];
}

// Env override exists so tests can point the cache at a temp dir without
// touching the user's real ~/.openmausbot.
const cacheDir = () => process.env.OMB_PROMPT_CACHE_DIR ?? join(DATA_DIR, "prompt-cache");

export async function clearDistillCache(): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  for (const entry of await readdir(cacheDir())) {
    if (entry.endsWith(".json")) await rm(join(cacheDir(), entry));
  }
}

function distillRequest(source: string): string {
  return [
    "Distill the following system prompt into vendor-neutral operating principles.",
    "",
    "--- SYSTEM PROMPT START ---",
    source,
    "--- SYSTEM PROMPT END ---",
  ].join("\n");
}

/** One source prompt → one distilled preset, via cache or a live call. */
export async function distillPrompt(
  preset: { id: string; label: string; description: string; text: string; sourceUrl: string },
  complete: DistillComplete,
): Promise<DistilledPrompt> {
  const hash = createHash("sha256").update(preset.text, "utf8").digest("hex").slice(0, 24);
  const cached = await readCache(hash);
  if (cached) return { ...preset, text: cached, distilled: true };

  const distilled = await complete(distillRequest(preset.text));
  const text = distilled.trim();
  if (!text) throw new Error("the model returned an empty distillation");
  if (Buffer.byteLength(text, "utf8") > PROMPT_PRESET_MAX_BYTES) {
    throw new Error(`distilled result is over the ${PROMPT_PRESET_MAX_BYTES}-byte SOUL cap (${Buffer.byteLength(text, "utf8")} bytes)`);
  }
  await writeCache(hash, text);
  return { ...preset, text, distilled: true };
}

/** Distill a batch. One failure is one error line; the rest still land. */
export async function distillPrompts(
  presets: Array<{ id: string; label: string; description: string; text: string; sourceUrl: string }>,
  complete: DistillComplete,
  limit = 4,
  maxPrompts = 12,
): Promise<DistillOutcome> {
  const skipped = Math.max(0, presets.length - maxPrompts);
  const selected = presets.slice(0, maxPrompts);
  const out: DistillOutcome = { presets: [], errors: skipped > 0 ? [`(distilled the first ${maxPrompts} of ${presets.length} prompts; re-run on a specific file for the rest)`] : [] };
  for (let i = 0; i < selected.length; i += limit) {
    await Promise.all(selected.slice(i, i + limit).map(async (preset) => {
      try {
        out.presets.push(await distillPrompt(preset, complete));
      } catch (error) {
        out.errors.push(`${preset.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  out.presets.sort((a, b) => selected.findIndex((p) => p.id === a.id) - selected.findIndex((p) => p.id === b.id));
  return out;
}

// ── cache ───────────────────────────────────────────────────────────────
// One JSON file per source hash in DATA_DIR/prompt-cache. Writing the cache
// is best-effort: a read-only home degrades to distilling every time, never
// to a failure.
async function cachePath(hash: string): Promise<string> {
  return join(cacheDir(), `${hash}.json`);
}

async function readCache(hash: string): Promise<string | null> {
  try {
    const path = await cachePath(hash);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(await readFile(path, "utf8")) as { text?: unknown; hash?: unknown };
    if (raw.hash !== hash || typeof raw.text !== "string" || !raw.text.trim()) return null;
    return raw.text;
  } catch {
    return null;
  }
}

async function writeCache(hash: string, text: string): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(await cachePath(hash), JSON.stringify({ hash, text, at: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // best effort, by design
  }
}
