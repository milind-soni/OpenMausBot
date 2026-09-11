/** App-wide compact-around presets. The number is the compact *ceiling*;
 * the live model window is recycled at 80% of it. Auto (null) applies
 * AUTO_COMPACT_AROUND_TOKENS when the advertised window is larger and RAM
 * did not already clamp. */
export const COMPACTION_RATIO = 0.8;

export const COMPACT_AROUND_PRESETS = [32_000, 64_000, 96_000, 128_000, 160_000] as const;
export type CompactAroundPreset = (typeof COMPACT_AROUND_PRESETS)[number];

/** Auto recycle cap when Unsloth/oMLX advertise 256k and RAM never binds. */
export const AUTO_COMPACT_AROUND_TOKENS = 128_000;

export function isCompactAroundPreset(value: number): value is CompactAroundPreset {
  return (COMPACT_AROUND_PRESETS as readonly number[]).includes(value);
}

export function formatTokenK(tokens: number): string {
  return `${Math.round(tokens / 1_000)}k`;
}

export function compactFireTokens(ceilingTokens: number): number {
  return Math.floor(ceilingTokens * COMPACTION_RATIO);
}

/** How large the rewritten state vector may be. Auto = 15% of compact ceiling, capped at 6k.
 * Presets go up to the compact-around window so a big local stack can keep a full page. */
export const VECTOR_BUDGET_PRESETS = [
  2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 16_000, 32_000, 64_000, 96_000, 128_000, 160_000,
] as const;
export type VectorBudgetPreset = (typeof VECTOR_BUDGET_PRESETS)[number];
export const VECTOR_BUDGET_AUTO_CAP = 6_000;
export const VECTOR_BUDGET_MAX = 160_000;
export const VECTOR_PROMPT_MAX = 8_000;

export function isVectorBudgetPreset(value: number): value is VectorBudgetPreset {
  return (VECTOR_BUDGET_PRESETS as readonly number[]).includes(value);
}

/** Host prefixes on injected local-model ids (`unsloth::…`, `ollama::…`). */
export const LOCAL_INJECT_HOST_IDS = [
  "omlx",
  "ollama",
  "local_ollama",
  "exo",
  "lmstudio",
  "unsloth",
  "unsloth_api",
] as const;

/** True when the picker id is a local host inject (Unsloth, oMLX, Ollama, LM Studio, EXO). */
export function isLocalInjectModelId(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const sep = modelId.indexOf("::");
  if (sep <= 0) return false;
  const host = modelId.slice(0, sep);
  return (LOCAL_INJECT_HOST_IDS as readonly string[]).includes(host);
}

/** Default rewrite instructions. Editable in App Settings → Experimental. Code still
 * never clips Open/Next and never smears chat over a disk handoff. */
export const DEFAULT_EXTRACTION_PROMPT =
  "Write a recap a successor can continue from without the transcript. Use the headings below as a template — include everything needed to hand off cleanly; do not artificially shorten or cap length for “one page.” Nitpick what matters from the notebook and turns; omit fluff. " +
  "Prefer these headings when they have content:\nGoal\nThis turn\nVerified facts\nAddresses\nLandmines\nConstraints\nOpen\n" +
  "Omit empty sections entirely — never write (none), (not stated), or filler placeholders. " +
  "This turn: include when useful — the last move that mattered (short). " +
  "Verified facts: live truth only. Name dead ends in one line each (do not redo). " +
  "Addresses: live file paths, symbols, IDs, and 0x… values, one per line — omit the section unless real. " +
  "Landmines: what would destroy work if forgotten — omit the section unless real. " +
  "Constraints: never-do rules — omit unless real. " +
  "Open: unfinished work or a real pending decision the successor still needs — reference only, not a fake prompt. Omit Open entirely when nothing is open. " +
  "Never soft-park Open (or legacy Next): do not write provide a prompt, await user, wait for next, wait for next instruction, done, confirm last turn, provide first/next instruction or task, ask for a first instruction, confirm/verify/search for a previous chat turn, an essay from last turn, that you do not see it in history, or any meta about a missing transcript. " +
  "Do not mention compaction, recycling, or a refreshed session. " +
  "Drop long recipes, logs, UNIQUE/pad blobs, and how-tos a successor can re-read from disk (handoff_*.md / MEMORY.md). Keep short markers, paths, and ids — never paste bulk hex. " +
  "When a running notebook is present, that notebook plus the last turn are the truth sources for Verified facts / Goal / This turn / Addresses / Open — prefer live task truth over unrelated durable notes when they conflict. " +
  "Without a notebook, prefer the workspace MEMORY.md / handoff_*.md seed over tool chips and old chat. " +
  "MEMORY.md is for durable constraints still clearly relevant; never copy old markers from durable notes when the notebook contradicts or covers the task. " +
  "The latest user message is live truth — quote it; do not replace it with an older Goal from seed. " +
  "This recap must work for any local task (code, research, ops), not one domain. " +
  "Ignore [tool …] chips. Quote verbatim. Do not invent. Do not invent the next patch or feature.";

