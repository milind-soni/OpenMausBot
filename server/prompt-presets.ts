// The prompt library: original built-in SOUL presets plus on-demand import
// from a GitHub repo the user names. Nothing is stored server-side — the
// catalog endpoint is read-only, and applying a preset goes through the
// normal bot patch, so the SOUL cap, history, and drift logic all keep
// single ownership. Import mirrors skill-fetch's caps: GitHub hosts only,
// bounded requests/bytes, markdown only.
import { z } from "zod";

export const PROMPT_PRESET_MAX_BYTES = 24_000; // BOT_PROFILE_LIMITS.soul
const MAX_FILES = 30;
const MAX_FILE_BYTES = 256 * 1024;
const API = "https://api.github.com";

export interface PromptPreset {
  id: string;
  label: string;
  description: string;
  text: string;
  source: "built-in" | { url: string };
}

// ── built-ins: original, short, OpenMausBot-style standing instructions ──
export const BUILT_IN_PRESETS: PromptPreset[] = [
  {
    id: "concise-coder",
    label: "Concise coder",
    description: "Minimum words, working code, no hedging.",
    text: `You are a senior software engineer.

- Lead with the code; explain only what the code cannot say.
- Never restate the question. Never apologize. Never hedge.
- If a requirement is ambiguous, pick the most conservative reading and say so in one line.
- Refuse to produce code you have not reasoned through; say what is missing instead.`,
    source: "built-in",
  },
  {
    id: "code-reviewer",
    label: "Code reviewer",
    description: "Find real defects; rank by severity; no style nitpicks.",
    text: `You are a staff-level code reviewer.

- Report only defects that change behavior: correctness, security, concurrency, resource leaks, error handling.
- Rank findings: blocker, major, minor. One line each on why it matters and the smallest fix.
- Style and naming are out of scope unless they hide a bug.
- Say "nothing found" when nothing is found; never invent findings to seem thorough.`,
    source: "built-in",
  },
  {
    id: "technical-writer",
    label: "Technical writer",
    description: "Plain language, examples first, zero filler.",
    text: `You are a technical writer for developers.

- Start with a working example, then explain it. Never start with background.
- Short sentences. Present tense. Second person.
- Every claim is shown, not asserted: code, command output, or a measurable fact.
- Delete any sentence that would survive being cut.`,
    source: "built-in",
  },
  {
    id: "data-analyst",
    label: "Data analyst",
    description: "Show the numbers, state the uncertainty, no overclaims.",
    text: `You are a rigorous data analyst.

- Answer with the number first, then the caveat. Never bury the result.
- State sample size, time range, and exclusions for every figure.
- Distinguish what the data shows from what it suggests; correlation is named as correlation.
- If the data cannot answer the question, say exactly what data would.`,
    source: "built-in",
  },
  {
    id: "socratic-tutor",
    label: "Socratic tutor",
    description: "Teach by asking; never give the answer unprompted.",
    text: `You are a tutor who teaches by questioning.

- After the learner states an idea, ask the one question that tests it.
- Never give the final answer while a productive question remains unasked.
- Adjust depth to the learner's last reply: correct guesses get harder questions, confusion gets a smaller concrete example.
- Praise only specifics; never generic encouragement.`,
    source: "built-in",
  },
  {
    id: "red-team",
    label: "Red-team critic",
    description: "Attack the plan honestly before reality does.",
    text: `You are the critic in the room.

- For every plan, name the three most likely ways it fails, ordered by probability times damage.
- Attack assumptions, not people. Quote the exact assumption you are attacking.
- End with the cheapest test that would kill the plan early, if there is one.
- If the plan is sound, say so plainly and stop; do not manufacture risk.`,
    source: "built-in",
  },
  {
    id: "status-reporter",
    label: "Status reporter",
    description: "Facts, deltas, blockers — nothing else.",
    text: `You write status updates.

- Structure: what changed, what is next, what is blocked. Nothing else.
- Every line is a fact with a date or a number attached.
- "Blocked" lines name the owner and the specific unblock action.
- No adjectives. "Good progress" is not a status.`,
    source: "built-in",
  },
  {
    id: "brainstorm",
    label: "Brainstorm partner",
    description: "Diverge wide, converge hard, no yes-and-ing.",
    text: `You are a brainstorming partner.

- First pass: ten ideas, each one line, ranged from safe to strange. No commentary between them.
- Second pass: pick the two you would actually bet on and argue the bet in three lines each.
- Kill any idea you cannot state in one sentence.
- Never open with "Great question" or restate the prompt.`,
    source: "built-in",
  },
];

const underCap = (text: string): boolean => Buffer.byteLength(text, "utf8") <= PROMPT_PRESET_MAX_BYTES;

/** Wire shape for the catalog endpoint. Accepts built-ins and imported
 * prompts, normalizing both sources to a string. */
export function presetWire(preset: PromptPreset | ImportedPrompt): { id: string; label: string; description: string; text: string; source: string } {
  const source = "sourceUrl" in preset
    ? preset.sourceUrl
    : typeof preset.source === "string"
      ? preset.source
      : preset.source.url;
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    text: preset.text,
    source,
  };
}

// ── GitHub import ────────────────────────────────────────────────────────
// Same host policy as skill imports: api.github.com and
// raw.githubusercontent.com only, discovered through one URL grammar.

interface Target {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

/** owner/repo, github.com/owner/repo[/tree/<ref>/<path>], or a raw/blob URL
 * straight to a markdown file. Anything else is refused, loudly. */
export function parsePromptSource(input: string): Target | { rawUrl: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "paste a GitHub repository, folder, or markdown file URL" };
  if (/^https?:\/\/raw\.githubusercontent\.com\/.+\/.+\/[^/]+\/.+\.(md|markdown|txt)$/i.test(text)) return { rawUrl: text };
  const blob = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.(?:md|markdown|txt))$/i);
  if (blob) {
    return { rawUrl: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}` };
  }
  const tree = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (tree) {
    return { owner: tree[1]!, repo: tree[2]!, ref: tree[3], path: tree[4] ?? "" };
  }
  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, path: "" };
  return { error: "that does not look like a GitHub repository, folder, or markdown file URL" };
}

const CONTENT_ENTRY = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  download_url: z.string().nullable().optional(),
});
const CONTENT_LISTING = z.array(z.unknown()).catch([]);

function asEntries(listing: z.infer<typeof CONTENT_LISTING>): z.infer<typeof CONTENT_ENTRY>[] {
  return listing.flatMap((item) => {
    const entry = CONTENT_ENTRY.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

class ImportLimitError extends Error {}

function boundedImportFetch(fetcher: typeof fetch): typeof fetch {
  let requests = 0;
  const signal = AbortSignal.timeout(60_000);
  return async (input, init) => {
    if (++requests > 64) throw new ImportLimitError("import request limit reached");
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response;
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_FILE_BYTES) throw new ImportLimitError("file is larger than the 256KB import cap");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
}

async function listDir(target: Target, path: string, fetcher: typeof fetch): Promise<z.infer<typeof CONTENT_ENTRY>[]> {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : "";
  const url = `${API}/repos/${target.owner}/${target.repo}/contents/${path}${ref}`;
  const response = await fetcher(url, { headers: { accept: "application/vnd.github+json", "user-agent": "OpenMausBot-prompt-library" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return asEntries(CONTENT_LISTING.parse(await response.json()));
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { headers: { "user-agent": "OpenMausBot-prompt-library" } });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new ImportLimitError("file is larger than the 256KB import cap");
  return text;
}

/** Label from the first markdown H1, else the filename stem. Description
 * from the first non-heading paragraph, trimmed. Both plain functions so
 * tests can pin them without network. */
export function labelFromMarkdown(name: string, text: string): { label: string; description: string } {
  const stem = name.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
  const lines = text.split(/\r?\n/);
  const h1 = lines.find((line) => /^#\s+\S/.test(line));
  const label = (h1 ? h1.replace(/^#\s+/, "") : stem).trim().slice(0, 80) || stem;
  const paragraphs = lines.filter((line) => line.trim() && !/^#{1,6}\s/.test(line) && !/^[-*|]/.test(line));
  const description = (paragraphs[0] ?? "").trim().slice(0, 200);
  return { label, description };
}

export interface ImportedPrompt {
  id: string;
  label: string;
  description: string;
  text: string;
  sourceUrl: string;
}

/** One markdown file → one preset. Oversized instruction files are skipped
 * with an error, never truncated: a silently cut system prompt is a bug. */
export async function fetchPromptsFromSource(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<{ presets: ImportedPrompt[]; errors: string[] } | { error: string }> {
  const parsed = parsePromptSource(input);
  if ("error" in parsed) return parsed;
  fetcher = boundedImportFetch(fetcher);
  try {
    const files: Array<{ name: string; url: string }> = [];
    if ("rawUrl" in parsed) {
      const name = parsed.rawUrl.split("/").pop() ?? "prompt.md";
      files.push({ name, url: parsed.rawUrl });
    } else {
      const entries = await listDir(parsed, parsed.path, fetcher);
      const markdown = entries
        .filter((entry) => entry.type === "file" && /\.(md|markdown|txt)$/i.test(entry.name) && entry.download_url)
        .slice(0, MAX_FILES);
      if (!markdown.length) {
        return { error: "no markdown files found there — paste a repo, folder, or a link to a specific file" };
      }
      for (const entry of markdown) files.push({ name: entry.name, url: entry.download_url! });
    }
    const presets: ImportedPrompt[] = [];
    const errors: string[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < files.length; i += 4) {
      await Promise.all(files.slice(i, i + 4).map(async (file) => {
        try {
          const text = await fetchText(file.url, fetcher);
          if (!underCap(text)) {
            errors.push(`${file.name}: over the ${PROMPT_PRESET_MAX_BYTES}-byte SOUL limit (${Buffer.byteLength(text, "utf8")} bytes)`);
            return;
          }
          const { label, description } = labelFromMarkdown(file.name, text);
          let id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || `prompt-${presets.length + 1}`;
          while (seenIds.has(id)) id = `${id}-2`;
          seenIds.add(id);
          presets.push({ id, label, description, text, sourceUrl: file.url });
        } catch (error) {
          errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    }
    if (!presets.length) return { error: errors.join("; ") || "nothing importable found" };
    return { presets, errors };
  } catch (error) {
    if (error instanceof ImportLimitError) return { error: error.message };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
