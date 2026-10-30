// Bringing a shared Grok Bot into OpenMausBot. A public x.ai/bot/<id> page
// shows only the name, creator and description, so the full setup comes from
// the person's own Grok Bot: they paste GROK_EXPORT_PROMPT into it and paste
// the JSON it writes back here. Both turn into an ordinary openmaus.package v2,
// so the usual preview and import rules apply (skills off, routines paused, no
// model, no keys). Pure text: the renderer and the server both read it.
import {
  AGENT_MAX_SKILLS, PACKAGE_FORMAT, PACKAGE_VERSION, SEED_FILE_MAX_BYTES,
  parsePackageDocument, redactPackageSecrets, utf8Bytes, type PackageDocument, type PackageRoutineSchedule,
} from "./package-format.ts";
import { BOT_PROFILE_LIMITS } from "./bot-profile.ts";
import { normalizeCronSchedule } from "./routine-schedule.ts";
import { parseSkillMd, SKILL_FILE_MAX_BYTES, yamlFrontmatterValue } from "./skill-md.ts";

export const GROK_EXPORT_FORMAT = "openmaus.grok/1";
/** pi-grokbot-import's export (github.com/Shixuuu/pi-grokbot-import). */
export const GROK_BUNDLE_FORMAT = "grokbot-bundle/v1";
const MAX_EXPORT_CHARS = 4 * 1024 * 1024;
const MAX_ROUTINES = 50;
const MAX_APPS = 30;

/** What the public share page shows. */
export interface GrokTemplateCard {
  shareId: string;
  name: string;
  creator?: string;
  description: string;
  url: string;
  color?: string;
}

export interface GrokExport {
  format: typeof GROK_EXPORT_FORMAT | typeof GROK_BUNDLE_FORMAT;
  name: string;
  title?: string;
  description: string;
  instructions: string;
  creator?: string;
  sourceUrl?: string;
  color?: string;
  skills: Array<{ name: string; description: string; body: string }>;
  routines: Array<{ name: string; schedule: string; cron: string; timeZone: string; prompt: string }>;
  plugins: Array<{ name: string; note: string }>;
  memories: string[];
}

/** Something the package could not carry, with what the person needs to redo it by hand. */
export interface GrokLeftOut {
  kind: "instructions" | "skill" | "routine" | "app" | "memories" | "secrets";
  name: string;
  reason: string;
  original?: string;
}

export class GrokImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokImportError";
  }
}

const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;

/** The share id from https://x.ai/bot/<id> (www, a trailing slash or a query allowed) or grokbot://app/v1/bot-template?id=<id>. */
export function grokShareIdFrom(text: string): string | null {
  const raw = String(text ?? "").trim();
  let url: URL;
  try {
    url = new URL(/^(?:www\.)?x\.ai\//i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  if (url.protocol === "grokbot:") {
    const id = url.searchParams.get("id") ?? "";
    return url.hostname === "app" && url.pathname === "/v1/bot-template" && SHARE_ID.test(id) ? id : null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "x.ai" && url.hostname !== "www.x.ai")) return null;
  const match = url.pathname.match(/^\/bot\/([^/]+)\/?$/);
  return match && SHARE_ID.test(match[1]!) ? match[1]! : null;
}

export const grokShareUrl = (shareId: string) => `https://x.ai/bot/${shareId}`;

const MARKETPLACE_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** The slug of a Grok Bot marketplace page, https://x.ai/bot/marketplace/bots/<slug>; its share link is on that page. */
export function grokMarketplaceSlugFrom(text: string): string | null {
  const raw = String(text ?? "").trim();
  let url: URL;
  try {
    url = new URL(/^(?:www\.)?x\.ai\//i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.protocol !== "https:" || (url.hostname !== "x.ai" && url.hostname !== "www.x.ai")) return null;
  const match = url.pathname.match(/^\/bot\/marketplace\/bots\/([^/]+)\/?$/);
  return match && MARKETPLACE_SLUG.test(match[1]!) ? match[1]! : null;
}

export const grokMarketplaceUrl = (slug: string) => `https://x.ai/bot/marketplace/bots/${slug}`;

/** A Grok Bot share link, its grokbot:// button link, or a marketplace page. */
export const isGrokLink = (text: string) => Boolean(grokShareIdFrom(text) ?? grokMarketplaceSlugFrom(text));

export const GROK_EXPORT_PROMPT = `Please export your setup so I can run you in OpenMausBot.

Reply with ONE JSON code block and nothing else, in exactly this shape:

\`\`\`json
{
  "format": "${GROK_EXPORT_FORMAT}",
  "source": "Grok Bot",
  "name": "<your name>",
  "description": "<one or two sentences on what you do>",
  "instructions": "<your full standing instructions, word for word>",
  "skills": [{ "name": "<skill-name>", "description": "<when to use it>", "body": "<the whole skill, word for word>" }],
  "routines": [{ "name": "<name>", "schedule": "<when it runs, in plain words>", "cron": "<minute hour day-of-month month weekday>", "timeZone": "<IANA time zone, such as America/New_York>", "prompt": "<what it does, word for word>" }],
  "plugins": ["<each plugin or app you use, such as Gmail, Slack or GitHub>"],
  "memories": []
}
\`\`\`

Rules:
- Copy your instructions, skills and routine prompts exactly. Do not summarise or shorten them.
- Give every timed routine a five-field cron and its IANA time zone. For a routine that starts on an event (a Slack message, a GitHub event, an email), leave "cron" empty and describe the event in "schedule".
- Fill "memories" with short facts you remember about me only if I say yes below. Otherwise leave it [].
- Never include API keys, tokens, passwords, email addresses, phone numbers or customer data. Write [removed] in their place.
- Use [] for anything you do not have.

Include memories: no`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const first = (...values: unknown[]) => values.map(str).find(Boolean) ?? "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** One line of plain text: control and separator characters become spaces (a scan, as in bot-profile.ts). */
function oneLine(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

/** The JSON object in a pasted reply: inside a ```json fence, or the outermost braces. */
function replyObject(text: string): unknown {
  if (text.length > MAX_EXPORT_CHARS) throw new GrokImportError("That reply is larger than 4 MB.");
  const candidates = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)].map((match) => match[1]!);
  const open = text.indexOf("{"), close = text.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (isRecord(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw new GrokImportError("That is not the JSON reply from Grok Bot. Copy the whole code block it wrote and paste it here.");
}

/** A reply or file that says it is a Grok Bot export (it may still be malformed). */
export function isGrokExport(value: unknown): boolean {
  if (typeof value === "string") return value.includes(GROK_EXPORT_FORMAT) || value.includes(GROK_BUNDLE_FORMAT);
  return isRecord(value) && (value.format === GROK_EXPORT_FORMAT || value.format === GROK_BUNDLE_FORMAT);
}

/** Forgiving reader for openmaus.grok/1 and grokbot-bundle/v1: text (fenced or not) or an object. */
export function parseGrokExport(input: unknown): GrokExport {
  const root = typeof input === "string" ? replyObject(input.replace(/^\uFEFF/, "")) : input;
  if (!isRecord(root)) throw new GrokImportError("That is not a Grok Bot export.");
  const format = root.format;
  const bundle = format === GROK_BUNDLE_FORMAT;
  if (format !== undefined && format !== GROK_EXPORT_FORMAT && !bundle) throw new GrokImportError("That is not a Grok Bot export.");
  const persona = isRecord(root.persona) ? root.persona : {};
  const source = isRecord(root.source) ? root.source : {};
  const instructions = first(root.instructions, root.soul, root.systemPrompt, persona.instructions, persona.description);
  const name = oneLine(first(root.name, persona.name, root.botName));
  if (!name && !instructions) throw new GrokImportError("That Grok Bot export has no name or instructions.");
  // A bundle keeps its instructions in persona.description: describe the bot by their first paragraph.
  const description = first(root.description, persona.description === instructions ? "" : persona.description) ||
    (bundle ? clip(instructions.split(/\n\s*\n/)[0]!.trim(), 300) : "");
  const title = oneLine(first(root.title, persona.title));
  const creator = oneLine(first(root.creator, root.author, source.sharerName));
  const color = first(root.color, persona.avatarColor, source.color);
  const shareId = grokShareIdFrom(first(typeof root.source === "string" ? root.source : "", source.url, root.url, root.sourceUrl));
  const skills = list(root.skills).flatMap((skill) => {
    if (typeof skill === "string") return [{ name: skill, description: "", body: "" }];
    if (!isRecord(skill)) return [];
    return [{ name: first(skill.name, skill.title), description: first(skill.description, skill.summary), body: first(skill.body, skill.instructions, skill.content, skill.text) }];
  });
  const routines = list(root.routines).flatMap((routine) => {
    if (!isRecord(routine)) return [];
    return [{
      name: first(routine.name, routine.title),
      schedule: first(routine.schedule, routine.when, routine.trigger, routine.triggerSummary),
      cron: first(routine.cron, routine.cronExpression),
      timeZone: first(routine.timeZone, routine.timezone, routine.tz),
      prompt: first(routine.prompt, routine.instructions, routine.task),
    }];
  });
  const plugins = list(root.plugins ?? root.apps ?? root.integrations).flatMap((plugin) => {
    const label = typeof plugin === "string" ? plugin.trim() : isRecord(plugin) ? first(plugin.name, plugin.label, plugin.id, plugin.slug) : "";
    return label ? [{ name: oneLine(label), note: isRecord(plugin) ? first(plugin.note, plugin.reason, plugin.description) : "" }] : [];
  });
  const memories = list(root.memories).map((memory) => (isRecord(memory) ? first(memory.text, memory.content) : str(memory))).filter(Boolean);
  return {
    format: bundle ? GROK_BUNDLE_FORMAT : GROK_EXPORT_FORMAT,
    name: name || "Grok Bot",
    ...(title ? { title } : {}),
    description,
    instructions,
    ...(creator ? { creator } : {}),
    ...(shareId ? { sourceUrl: grokShareUrl(shareId) } : {}),
    ...(color ? { color } : {}),
    skills,
    routines,
    plugins,
    memories,
  };
}

/** The mascot palette (src/lib/mascot.ts MAUS_COLORS). */
const PALETTE = {
  green: "#009957", blue: "#377FE6", red: "#D94B52", orange: "#E78531", purple: "#8057C8",
  cyan: "#0EA5C6", pink: "#D84F8B", yellow: "#D8A729", teal: "#01A492", coral: "#E5634E",
} as const;
type BotColor = keyof typeof PALETTE;

function rgb(hex: string): [number, number, number] | null {
  const match = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join("") : match[1]!;
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as [number, number, number];
}

/** The nearest bot colour; greys and unreadable values get blue. */
export function nearestBotColor(hex: string | undefined): BotColor {
  const value = hex ? rgb(hex) : null;
  if (!value || Math.max(...value) - Math.min(...value) < 40) return "blue";
  let best: BotColor = "blue", distance = Infinity;
  for (const [name, swatch] of Object.entries(PALETTE) as Array<[BotColor, string]>) {
    const other = rgb(swatch)!;
    const next = value.reduce((sum, channel, index) => sum + (channel - other[index]!) ** 2, 0);
    if (next < distance) [best, distance] = [name, next];
  }
  return best;
}

const slug = (value: string, max: number) =>
  value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

function uniqueSlug(value: string, fallback: string, taken: Set<string>, max = 64): string {
  const base = slug(value, max - 3) || fallback;
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/** FNV-1a: a short stable suffix for the package id, not a security boundary. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

function fitBytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  let end = Math.min(text.length, max);
  while (end > 0 && utf8Bytes(text.slice(0, end)) > max) end = Math.floor(end * 0.95);
  return text.slice(0, end);
}

/** Composio toolkit slugs for the apps Grok Bot plugins usually name. */
const COMPOSIO_SLUGS: Record<string, string> = {
  gmail: "gmail", "google mail": "gmail", slack: "slack", github: "github", notion: "notion", linear: "linear",
  x: "twitter", twitter: "twitter", "x (twitter)": "twitter", discord: "discord", reddit: "reddit",
  "google calendar": "googlecalendar", calendar: "googlecalendar", "google drive": "googledrive", drive: "googledrive",
  "google sheets": "googlesheets", sheets: "googlesheets", "google docs": "googledocs", docs: "googledocs",
  hubspot: "hubspot", salesforce: "salesforce", jira: "jira", asana: "asana", trello: "trello", dropbox: "dropbox",
  airtable: "airtable", figma: "figma", stripe: "stripe", sentry: "sentry", posthog: "posthog", zapier: "zapier",
  outlook: "outlook", "microsoft outlook": "outlook", "microsoft teams": "microsoft_teams", teams: "microsoft_teams",
  youtube: "youtube", linkedin: "linkedin", shopify: "shopify", calendly: "calendly", zoom: "zoom",
};

/** The Composio toolkit for an app a Grok Bot names, when Maus knows one. */
export const composioSlugFor = (label: string): string | undefined => COMPOSIO_SLUGS[label.trim().toLowerCase().replace(/\s+/g, " ")];

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const EVENT_WORDS = /\b(?:when|whenever|each time|every time|on (?:new|each|every)|webhook|mention(?:ed|s)?|incoming|arrives?|opens?|merged?|pushed?)\b/i;

/** "Weekdays at 9am", "every day at 18:30", "Mondays and Thursdays at 10" → a daily schedule. */
function simpleDaily(text: string): PackageRoutineSchedule | null {
  const lower = text.toLowerCase();
  if (EVENT_WORDS.test(lower) || /\b(?:hour|hourly|minute|minutes|month|monthly|year)\b/.test(lower)) return null;
  let hour: number, minute = 0;
  const clock = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/) ?? lower.match(/\b(\d{1,2}):(\d{2})\b/) ?? lower.match(/\bat (\d{1,2})\b/);
  if (/\bnoon\b/.test(lower)) hour = 12;
  else if (/\bmidnight\b/.test(lower)) hour = 0;
  else if (clock) {
    hour = Number(clock[1]);
    minute = clock[2] ? Number(clock[2]) : 0;
    const half = clock[3]?.[0];
    if (half && (hour < 1 || hour > 12)) return null;
    if (half === "p" && hour < 12) hour += 12;
    if (half === "a" && hour === 12) hour = 0;
  } else return null;
  if (hour > 23 || minute > 59) return null;
  let weekdays: number[] = [];
  if (/\bweekdays?\b|\bmon(?:day)?s?\s*(?:-|–|to|through)\s*fri(?:day)?\b|\bbusiness days?\b|\bworkdays?\b/.test(lower)) weekdays = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(lower)) weekdays = [0, 6];
  else if (/\b(?:daily|every ?day|each day|every (?:morning|evening|night|afternoon))\b/.test(lower)) weekdays = [0, 1, 2, 3, 4, 5, 6];
  else weekdays = WEEKDAYS.flatMap((day, index) => (new RegExp(`\\b${day}(?:[a-z]*day)?s?\\b`).test(lower) ? [index] : []));
  if (!weekdays.length) return null;
  return { type: "daily", time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, weekdays };
}

/** Five fields whose minute and hour are cron, not words. */
function looksLikeCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.slice(0, 2).every((field) => /^[\d*/,-]+$/.test(field));
}

function routineSchedule(routine: GrokExport["routines"][number], timeZone: string): { schedule: PackageRoutineSchedule } | { reason: string } {
  const expression = routine.cron || (looksLikeCron(routine.schedule) ? routine.schedule : "");
  // A zone Maus cannot read falls back to the person's own; a cron it cannot read falls back to the plain words.
  for (const zone of expression ? [routine.timeZone || timeZone, timeZone] : []) {
    try {
      return { schedule: normalizeCronSchedule({ type: "cron", expression, timeZone: zone }) };
    } catch {
      // the next zone, then the plain words
    }
  }
  const daily = simpleDaily(routine.schedule);
  if (daily) return { schedule: daily };
  if (EVENT_WORDS.test(routine.schedule)) return { reason: "it starts on an event, not a clock" };
  return { reason: routine.schedule || routine.cron ? "its schedule could not be read" : "the export gave no schedule for it" };
}

function skillEntry(skill: GrokExport["skills"][number], name: string): { name: string; description: string; instructions: string } | null {
  const stripped = skill.body.replace(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/, "");
  const fromFrontmatter = skill.body === stripped ? "" : (parseSkillMd(skill.body) as { description?: string }).description ?? "";
  const body = stripped.trim();
  if (!body) return null;
  const description = clip(oneLine(skill.description || fromFrontmatter || body.split("\n").find((line) => line.trim())!.replace(/^#+\s*/, "")), 1_024);
  const instructions = `---\nname: ${name}\ndescription: ${yamlFrontmatterValue(description)}\n---\n\n${body}\n`;
  if (utf8Bytes(instructions) > SKILL_FILE_MAX_BYTES) return null;
  const parsed = parseSkillMd(instructions);
  return "error" in parsed || parsed.description !== description ? null : { name, description, instructions };
}

/** A Grok Bot export as one bot in an openmaus.package v2 file, plus what could not travel. */
export function grokExportToPackage(
  x: GrokExport,
  options: { sourceUrl?: string; timeZone?: string } = {},
): { document: PackageDocument; leftOut: GrokLeftOut[] } {
  const leftOut: GrokLeftOut[] = [];
  const skip = (item: GrokLeftOut): [] => {
    leftOut.push(item);
    return [];
  };
  const shareId = grokShareIdFrom(options.sourceUrl ?? "") ?? grokShareIdFrom(x.sourceUrl ?? "");
  const sourceUrl = shareId ? grokShareUrl(shareId) : undefined;
  const timeZone = options.timeZone?.trim() || "UTC";
  const name = clip(oneLine(x.name) || "Grok Bot", 100);
  const agentKey = slug(name, 60) || "grok-bot";
  const description = x.description.trim();

  let soul = x.instructions.trim();
  if (utf8Bytes(soul) > BOT_PROFILE_LIMITS.soul) {
    soul = fitBytes(soul, BOT_PROFILE_LIMITS.soul);
    skip({ kind: "instructions", name: "Standing instructions", reason: `they were longer than ${BOT_PROFILE_LIMITS.soul.toLocaleString("en-US")} bytes, so the end was cut. Check them after adding the bot` });
  }

  const skillNames = new Set<string>();
  const skills: Array<NonNullable<ReturnType<typeof skillEntry>>> = [];
  for (const [index, skill] of x.skills.entries()) {
    const label = `Skill “${oneLine(skill.name) || index + 1}”`;
    if (skills.length >= AGENT_MAX_SKILLS) {
      skip({ kind: "skill", name: label, reason: `a bot holds at most ${AGENT_MAX_SKILLS} skills`, ...(skill.body ? { original: skill.body } : {}) });
      continue;
    }
    const entry = skillEntry(skill, uniqueSlug(skill.name, `skill-${index + 1}`, skillNames));
    if (entry) skills.push(entry);
    else skip({ kind: "skill", name: label, reason: skill.body ? "its text could not be read as a skill" : "the export had no text for it" });
  }

  const routineKeys = new Set<string>();
  const routines = x.routines.flatMap((routine, index) => {
    const label = clip(oneLine(routine.name) || `Routine ${index + 1}`, 80);
    const item = {
      kind: "routine" as const,
      name: `Routine “${label}”`,
      original: [routine.schedule && `When: ${routine.schedule}`, routine.cron && `Cron: ${routine.cron}`, routine.prompt].filter(Boolean).join("\n"),
    };
    if (index >= MAX_ROUTINES) return skip({ ...item, reason: `a package holds at most ${MAX_ROUTINES} routines` });
    if (!routine.prompt) return skip({ ...item, reason: "the export had no prompt for it" });
    const timing = routineSchedule(routine, timeZone);
    if ("reason" in timing) return skip({ ...item, reason: timing.reason });
    return [{
      key: uniqueSlug(label, `routine-${index + 1}`, routineKeys),
      name: label,
      agent: agentKey,
      prompt: routine.prompt.slice(0, 20_000),
      runOn: "maus" as const,
      schedule: timing.schedule,
      durationMinutes: 30,
      enabledAfterInstall: false,
    }];
  });

  const appSlugs = new Set<string>();
  const apps = x.plugins.flatMap((plugin) => {
    const label = clip(plugin.name, 100);
    const appSlug = composioSlugFor(label) ?? slug(label, 60);
    if (!appSlug || appSlugs.has(appSlug)) return [];
    if (appSlugs.size >= MAX_APPS) return skip({ kind: "app", name: `App “${label}”`, reason: `a package lists at most ${MAX_APPS} apps` });
    appSlugs.add(appSlug);
    return [{ slug: appSlug, label, reason: clip(oneLine(plugin.note) || `${name} used ${label} in Grok Bot.`, 240) }];
  });

  let seed: { memory: Record<string, string> } | undefined;
  if (x.memories.length) {
    const notes = `# Notes from Grok Bot\n\n${x.memories.map((memory) => `- ${memory.replace(/\s*\n\s*/g, " ")}`).join("\n")}\n`;
    if (utf8Bytes(notes) <= SEED_FILE_MAX_BYTES) seed = { memory: { "MEMORY.md": notes } };
    else skip({ kind: "memories", name: "Memories", reason: "they were larger than 256 KB" });
  }

  const summary = clip(description || `${name}, brought over from Grok Bot.`, 2_000);
  const draft: PackageDocument = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    package: {
      id: `${slug(name, 60) || "grok-bot"}-${shortHash(shareId ?? `${name}\n${soul}`)}`,
      release: "1.0.0",
      name,
      tagline: clip(oneLine(summary), 160),
      summary,
      category: "Imported",
      author: { name: clip(x.creator || "Grok Bot creator", 100), ...(sourceUrl ? { url: sourceUrl } : {}) },
      license: "See source",
      outcomes: [clip(`${name} runs in OpenMausBot with your own engine and apps.`, 240)],
      setupMinutes: 5,
      requirements: { apps, capabilities: [] },
      team: { name: clip(name, 60) },
      agents: [{
        key: agentKey,
        name,
        ...(x.title ? { title: clip(oneLine(x.title), 200) } : {}),
        ...(description ? { description: clip(description, 4_000) } : {}),
        ...(soul ? { soul } : {}),
        appearance: { color: nearestBotColor(x.color) },
        ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
        ...(seed ? { seed } : {}),
      }],
      ...(routines.length ? { routines } : {}),
      ...(skills.length ? { skills: { version: 1 as const, entries: skills } } : {}),
    },
  };
  const { document, redacted } = redactPackageSecrets(draft);
  if (redacted.length) skip({ kind: "secrets", name: "Keys and passwords", reason: `text that looked like a key or password was replaced in ${redacted.join(", ")}` });
  try {
    return { document: parsePackageDocument(document, { trust: "file" }), leftOut };
  } catch (error) {
    throw new GrokImportError(`This Grok Bot export could not be turned into a bot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The recipe Cursor's GetGrokBotTemplateImportDetails points at, as an export. The field names follow
 * pi-grokbot-import (MIT, github.com/Shixuuu/pi-grokbot-import); a grokbot-bundle/v1 or openmaus.grok/1 is read as is. */
export function grokExportFromRecipe(recipe: unknown, card?: GrokTemplateCard): GrokExport {
  if (!isRecord(recipe)) throw new GrokImportError("Cursor's answer is not a Grok Bot recipe.");
  const fromCard = card ? { creator: card.creator, sourceUrl: card.url, description: card.description } : {};
  if (recipe.format === GROK_BUNDLE_FORMAT || recipe.format === GROK_EXPORT_FORMAT) {
    const x = parseGrokExport(recipe);
    return { ...x, ...(x.creator || !fromCard.creator ? {} : { creator: fromCard.creator }), ...(x.sourceUrl || !card ? {} : { sourceUrl: card.url }) };
  }
  const profile = isRecord(recipe.persona) ? recipe.persona : isRecord(recipe.profile) ? recipe.profile : {};
  const memory = recipe.memories ?? recipe.memory;
  const memories = typeof memory === "string" ? [memory] : isRecord(memory) ? [first(memory.text, memory.content, memory.profile, memory.md)] : list(memory);
  const started = recipe.gettingStarted;
  const starter = typeof started === "string" ? { body: started } : isRecord(started) ? { name: first(started.name), description: first(started.description), body: first(started.content, started.body, started.text) } : null;
  const skills = [
    ...(starter?.body ? [{ name: starter.name || "getting-started", description: starter.description || "Getting started with this bot.", body: starter.body }] : []),
    ...list(recipe.skills).map((skill) => isRecord(skill) ? { name: first(skill.name, skill.slug), description: first(skill.description), body: first(skill.body, skill.content, skill.text, skill.instructions) } : skill),
  ];
  const routines = list(recipe.routines).map((routine) => {
    if (!isRecord(routine)) return routine;
    const when = isRecord(routine.schedule) ? routine.schedule : {};
    return {
      name: first(routine.name, routine.slug),
      schedule: first(typeof routine.schedule === "string" ? routine.schedule : "", routine.triggerSummary, routine.trigger, routine.description),
      cron: first(routine.cron, when.cron, when.expression),
      timeZone: first(routine.timeZone, routine.timezone, when.timeZone, when.timezone),
      prompt: first(routine.prompt, routine.content, routine.body, routine.instructions),
    };
  });
  const plugins = list(recipe.plugins ?? recipe.integrations).map((plugin) =>
    isRecord(plugin) ? { name: first(plugin.name, plugin.pluginId, plugin.id, plugin.slug), note: first(plugin.note, plugin.description) } : plugin);
  const x = parseGrokExport({
    format: GROK_EXPORT_FORMAT,
    name: first(profile.name, recipe.botName, recipe.name, card?.name),
    title: first(profile.title),
    description: first(fromCard.description, recipe.description),
    instructions: first(recipe.instructions, profile.instructions, profile.systemPrompt, profile.description),
    creator: first(fromCard.creator),
    sourceUrl: first(fromCard.sourceUrl),
    color: first(profile.avatarColor, profile.color, recipe.avatarColor, recipe.color, card?.color),
    skills, routines, plugins, memories,
  });
  if (!x.instructions && !x.skills.length && !x.routines.length) throw new GrokImportError("Cursor's answer did not include the bot's setup.");
  return x;
}

/** A bot started from the public card alone: the name and description, credited to the share link. */
export function grokStarterPackage(card: GrokTemplateCard): PackageDocument {
  const credit = `Based on x.ai/bot/${card.shareId}${card.creator ? ` by ${card.creator}` : ""}.`;
  const what = card.description.trim() || "The share page did not say what it does, so ask the person what they need.";
  const instructions = [
    `You are ${card.name}, a bot started from the Grok Bot "${card.name}"${card.creator ? ` by ${card.creator}` : ""} (x.ai/bot/${card.shareId}).`,
    `What you do: ${what}`,
    "Work in that spirit. Before acting, ask for anything you need to know about the person's accounts, projects or preferences, and keep answers short and practical.",
  ].join("\n\n");
  return grokExportToPackage({
    format: GROK_EXPORT_FORMAT,
    name: card.name,
    description: card.description.trim() ? `${card.description.trim()}\n\n${credit}` : credit,
    instructions,
    ...(card.creator ? { creator: card.creator } : {}),
    ...(card.color ? { color: card.color } : {}),
    skills: [],
    routines: [],
    plugins: [],
    memories: [],
  }, { sourceUrl: grokShareUrl(card.shareId) }).document;
}
