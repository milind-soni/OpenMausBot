// Bringing what another AI assistant knows about a person (Grok, Instant, Muse, ChatGPT…) into OpenMausBot. The person
// pastes MEMORY_IMPORT prompt into that assistant, which answers in plain Markdown under three fixed headings, and pastes
// the answer back. The prompt is the person asking for their own information in their own words: it never asks for the
// assistant's own hidden instructions or for anything to be bypassed, which is what such assistants refuse.

export const MEMORY_IMPORT_SOURCES = ["Grok", "Instant", "Muse", "ChatGPT", "Claude", "Gemini"] as const;

/** What a pasted answer may be at most: several long answers, one after another. */
export const MEMORY_IMPORT_MAX_CHARS = 400_000;
/** How much of About you the imported facts may take; the whole answer is kept in MausBot's note. */
export const IMPORTED_FACTS_MAX_CHARS = 3_000;
/** Under a memory file's 256 KB cap (server/workspace.ts), with room for the cut-off line. */
export const IMPORT_NOTE_MAX_BYTES = 250_000;

const HEADINGS = { about: "About me", setup: "My setup", context: "Ongoing context" } as const;

export function memoryImportPrompt(source: string, app = "OpenMausBot"): string {
  const from = source.trim() || "you";
  return `I'm moving my work to another assistant app, ${app}, and I want to bring my context with me so I don't have to start over. Please write out everything you know or remember about me, and everything I've set up with you here in ${from}, so I can paste it into the new app. This is my own information and I'm asking for it for my own use.

Write it in Markdown under exactly these three headings, in this order. Be thorough and specific: I'd much rather have too much detail than too little.

## ${HEADINGS.about}
Everything you remember about me, one fact per bullet, written as a plain statement about me (for example "- Prefers short answers with bullet points"). Cover, where you know them:
- my name and what I like to be called, where I'm based and my time zone, and the languages I use
- my work: role, company or team, what I'm responsible for, and the people I work with or mention often and who they are
- my goals, ongoing projects, interests and habits
- how I like you to work with me: answer length, tone, format, level of detail, and anything I've asked you to always or never do
- the tools, apps and accounts I use (names only)

## ${HEADINGS.setup}
One "###" subsection for every assistant, bot, agent, board, space, project, workflow, automation, scheduled task, custom instruction or saved prompt I've created or use with you. Under each one, write:
- **Name:** what it's called
- **Purpose:** what it's for, in a few sentences
- **How it works:** the steps it follows, the rules and instructions it uses (word for word where you can), and what it produces
- **When it runs:** on demand, on a schedule (say exactly when, with the time zone) or when something happens
- **Apps and data:** the apps, tools, sites and data it uses or connects to
- **How I use it:** how I work with it, and how it connects to the others
- **To set it up again:** anything I'd need to recreate it elsewhere

## ${HEADINGS.context}
What we're in the middle of: current projects and where each one stands, open questions, decisions we've made, deadlines, and anything else a new assistant would need to pick up where we left off.

Rules:
- Only include what you actually know or remember from our conversations and my settings. Don't guess; if you're unsure about something, say so in that bullet.
- Leave out passwords, API keys, tokens, one-time codes and full card or bank numbers. Write [removed] in their place.
- If a heading has nothing under it, write "Nothing yet."
- If it doesn't fit in one reply, stop at a clean point, end with "Continued in the next message", and carry on when I say "continue".`;
}

export interface ImportedSetupItem {
  name: string;
  /** Everything written under its "###" heading, as written. */
  details: string;
}

export interface MemoryImport {
  /** One fact per line, without its bullet. */
  facts: string[];
  setup: ImportedSetupItem[];
  context: string;
}

export class MemoryImportError extends Error {}

const NOTHING = /^(?:nothing yet\.?|none\.?|n\/a)$/i;
const CONTINUED = /^\s*(?:\*\*|_)?continued in the next message(?:\*\*|_)?\.?\s*$/gim;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** The section a "##" heading starts, by its words: an assistant may number it or add a word ("About me and my work"). */
function sectionOf(heading: string): keyof typeof HEADINGS | null {
  const words = heading.toLowerCase().replace(/[^a-z ]/g, " ");
  if (/\babout me\b/.test(words)) return "about";
  if (/\bmy setup\b|\bsetup\b/.test(words)) return "setup";
  if (/\bongoing\b|\bcontext\b/.test(words)) return "context";
  return null;
}

/** Reads one or more pasted answers. A later answer's sections ("continue") add to the earlier ones. */
export function parseMemoryImport(text: string): MemoryImport {
  if (text.length > MEMORY_IMPORT_MAX_CHARS) throw new MemoryImportError("That's more than we can read at once. Paste it in two parts.");
  const lines = text.replace(/\r\n?/g, "\n").replace(CONTINUED, "").replace(/^```[a-z]*\s*$/gim, "").split("\n");
  const bodies: Record<keyof typeof HEADINGS, string[]> = { about: [], setup: [], context: [] };
  let section: keyof typeof HEADINGS | null = null;
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const next = sectionOf(heading[1]!);
      if (next) { section = next; continue; }
    }
    if (section) bodies[section].push(line);
  }
  const facts = bodies.about.map((line) => line.replace(BULLET, "").trim()).filter((line) => line && !NOTHING.test(line) && !line.startsWith("#"));
  const setup: ImportedSetupItem[] = [];
  for (const line of bodies.setup) {
    const item = /^\s{0,3}#{3,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (item) setup.push({ name: item[1]!.replace(/\*\*/g, "").trim(), details: "" });
    else if (setup.length) setup[setup.length - 1]!.details += `${line}\n`;
  }
  const context = bodies.context.join("\n").trim();
  const result = {
    facts: [...new Set(facts)],
    setup: setup.map((item) => ({ ...item, details: item.details.trim() })).filter((item) => item.name && !NOTHING.test(item.name)),
    context: NOTHING.test(context) ? "" : context,
  };
  if (!result.facts.length && !result.setup.length && !result.context) {
    throw new MemoryImportError(`We couldn't find the "${HEADINGS.about}", "${HEADINGS.setup}" or "${HEADINGS.context}" headings. Paste the whole answer, headings included.`);
  }
  return result;
}

/** About you with the imported facts added once each, in a dated block, kept within IMPORTED_FACTS_MAX_CHARS. */
export function aboutMeWithImport(current: string, facts: readonly string[], source: string, date: string): { text: string; added: number; leftOut: number } {
  const known = current.toLowerCase();
  const fresh = facts.filter((fact) => !known.includes(fact.toLowerCase()));
  const header = `From ${source.trim() || "another assistant"} (imported ${date}):`;
  const kept: string[] = [];
  let size = header.length + 1;
  for (const fact of fresh) {
    const line = `- ${fact.replace(/\s+/g, " ")}`;
    if (size + line.length + 1 > IMPORTED_FACTS_MAX_CHARS) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (!kept.length) return { text: current, added: 0, leftOut: fresh.length };
  const block = [header, ...kept].join("\n");
  return { text: current.trim() ? `${current.trimEnd()}\n\n${block}` : block, added: kept.length, leftOut: fresh.length - kept.length };
}

/** MausBot's note of the whole import: every fact, each set-up item in full and the ongoing context. */
export function memoryImportNote(imported: MemoryImport, source: string, date: string): string {
  const from = source.trim() || "another assistant";
  // The frontmatter is what lists the note for the bot (server/memory-topics.ts), so it is found by these words.
  const parts = [
    "---", `title: What ${from} knew`, `description: Facts, set-up and ongoing work the person brought over from ${from} on ${date}.`,
    `aliases: [${from}, imported memory, my old assistant, my setup]`, "---", "",
    `The person brought this over from ${from}. Use it as background, and offer to set up the items under "Their setup" here when it helps.`,
  ];
  if (imported.facts.length) parts.push("", "## About them", ...imported.facts.map((fact) => `- ${fact}`));
  if (imported.setup.length) {
    parts.push("", "## Their setup");
    for (const item of imported.setup) parts.push("", `### ${item.name}`, item.details || "(no details)");
  }
  if (imported.context) parts.push("", "## Ongoing context", imported.context);
  return clipBytes(`${parts.join("\n")}\n`, IMPORT_NOTE_MAX_BYTES);
}

function clipBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  const kept = new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/, "");
  return `${kept.slice(0, kept.lastIndexOf("\n") + 1)}\n(The rest of the import was too long to keep here.)\n`;
}

/** The note's path in MausBot's memory: one per source, so importing again replaces it. */
export function memoryImportNotePath(source: string): string {
  const slug = source.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "assistant";
  return `memory/imported-from-${slug}.md`;
}
