// Moving a Grok Bot here. Grok Bot keeps a Bot's setup in its own cloud account and has no export button, so the Bot
// writes its own: the person pastes GROK_EXPORT_PROMPT into its chat and brings back what it wrote. That text becomes an
// ordinary openmaus.package v2, so the package rules apply (skills off, routines paused, no model, no keys, no grants).
// Pure text: the renderer and the server both read it.
//
// The export's shape, the repairs for what a chat window does to it and its credential refusal adapt an MIT-licensed
// importer; see NOTICE.
import {
  AGENT_MAX_SKILLS, PACKAGE_FORMAT, PACKAGE_MAX_CONNECTIONS, PACKAGE_VERSION, SEED_FILE_MAX_BYTES,
  parsePackageDocument, utf8Bytes, type PackageDocument, type PackageRoutineSchedule,
} from "./package-format.ts";
import { BOT_PROFILE_LIMITS } from "./bot-profile.ts";
import { redactSecretsInText } from "./redact.ts";
import { normalizeCronSchedule } from "./routine-schedule.ts";
import { parseSkillMd, SKILL_FILE_MAX_BYTES, yamlFrontmatterValue } from "./skill-md.ts";

export const GROK_EXPORT_FORMAT = "grok-bot-export";
const OLD_EXPORT_FORMAT = "openmaus.grok/1";
/** How the file the Bot writes is named, one per Bot. */
export const GROK_EXPORT_FILE = /^grok-bot-export[^/\\]*\.(?:json|md|txt)$/i;
export const GROK_EXPORT_MAX_CHARS = 4 * 1024 * 1024;
const MAX_ROUTINES = 50;
const BOT_COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const;
const MAX_APPS = 30;
/** Failed brace matches before a reply stops being searched: each one scans to the end of the text. */
const MAX_UNBALANCED = 50;

export const GROK_EXPORT_PROMPT = `I'm moving to OpenMausBot and need a complete, machine-readable copy of your setup. Do not change, pause or delete anything.

Write one JSON document with exactly this shape, then save it as grok-bot-export-<your name>.json (your name in lowercase, spaces as hyphens): in my Downloads folder if you can write to my computer, otherwise in your workspace, and attach it to your reply. If you cannot attach files, put the whole document in a single \`\`\`json code block instead.

{
  "format": "${GROK_EXPORT_FORMAT}",
  "version": 1,
  "bots": [
    {
      "name": "your name",
      "title": "your label or job title, or empty",
      "instructions": "your full role, job description and lasting rules, word for word where you can",
      "memories": ["each thing you remember about the work, one string per fact"],
      "user_facts": ["each fact you know about me (name, time zone, preferences), one string per fact"],
      "skills": [
        {"name": "skill name", "description": "when to use it", "instructions": "the COMPLETE skill text, every step, rule and output format, word for word"}
      ],
      "routines": [
        {"name": "routine name",
         "instruction": "the COMPLETE instruction the routine runs, word for word",
         "trigger": "schedule | slack | github | linear | sentry | pagerduty | email | webhook | other",
         "schedule_cron": "5-field cron expression in the routine's time zone, such as 0 8 * * 1-5 (empty when not on a schedule)",
         "schedule_text": "when it runs, in words, as the app shows it",
         "timezone": "IANA time zone, such as America/New_York",
         "paused": false,
         "skills": ["names of the skills this routine uses"],
         "trigger_details": "for event triggers: channel, repository, phrase, senders and so on"}
      ],
      "apps": [{"name": "connected app or MCP server name", "mcp_url": "its remote MCP URL if it has one, else empty", "header_names": ["names of any headers it needs to sign in, names only"]}]
    }
  ]
}

Rules: include EVERY routine you own (paused ones too) and EVERY skill enabled for you, with full text, not summaries. If you cannot read something (a routine's schedule, a skill's text), leave it out and tell me in your reply what you left out; never guess or fill it in from memory. Never include passwords, API keys, tokens, webhook keys, cookies or card numbers, and no other people's contact details or customer data: leave those out entirely. Output valid JSON only (no comments).
If it is too long for one message or file, split it: send several documents, each complete and valid in this same shape with the same bot name, each holding the part the others do not. They are imported together.`;

export type GrokImportErrorCode = "notExport" | "cutOff" | "tooLarge" | "credentials" | "newerVersion" | "unusable";

export class GrokImportError extends Error {
  readonly code: GrokImportErrorCode;
  /** The credential-looking keys, for "credentials". */
  readonly keys: string[];
  constructor(code: GrokImportErrorCode, keys: string[] = []) {
    super(code);
    this.name = "GrokImportError";
    this.code = code;
    this.keys = keys;
  }
}

export interface GrokSkill { name: string; description: string; instructions: string }
export interface GrokRoutine {
  name: string; instruction: string; trigger: string; cron: string; when: string; timeZone: string;
  paused: boolean; skills: string[]; details: string;
}
export interface GrokApp { name: string; mcpUrl: string; transport: string; headerNames: string[]; envNames: string[] }
export interface GrokBot {
  name: string; title: string; description: string; instructions: string;
  memories: string[]; userFacts: string[]; skills: GrokSkill[]; routines: GrokRoutine[]; apps: GrokApp[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const first = (...values: unknown[]) => values.map(str).find(Boolean) ?? "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown) => list(value).map((item) => (isRecord(item) ? first(item.text, item.content, item.name) : str(item))).filter(Boolean);
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

const CREDENTIAL_KEY = /(?:^|_)(?:api_?key|apikey|token|secret|passwd|passphrase|credentials?|auth|authorization|bearer|cookies?|private_?key|access_?key|session_?(?:id|key|token))(?:_|$)|key$/i;
/** Named value slots of an app: their values are never read, so their names are listed rather than refused. */
const APP_VALUE_SLOTS = new Set(["headers", "env", "environment"]);

function isCredentialKey(key: string): boolean {
  return /password/i.test(key) || CREDENTIAL_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_"));
}

function credentialKeys(value: unknown, path = "", inApps = false): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => credentialKeys(item, `${path}[${index}]`, inApps));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key;
    if (inApps && APP_VALUE_SLOTS.has(key)) return [];
    return [...(isCredentialKey(key) ? [here] : []), ...credentialKeys(child, here, key === "apps" || key === "plugins")];
  });
}

/** Commas that directly precede a } or ], outside string values: what a chat app or phone leaves behind. */
function dropTrailingCommas(text: string): string {
  let out = "", quoted = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "," && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) continue;
    out += ch;
  }
  return out;
}

function looseJson(text: string): unknown {
  for (const attempt of [text, dropTrailingCommas(text)]) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // the next repair
    }
  }
  return undefined;
}

/** Every top-level {…} in a chat reply, by brace matching that respects JSON strings. */
function bracedObjects(text: string): string[] {
  const found: string[] = [];
  let unbalanced = 0;
  for (let at = text.indexOf("{"); at >= 0 && unbalanced < MAX_UNBALANCED;) {
    let depth = 0, quoted = false, end = -1;
    for (let i = at; i < text.length && end < 0; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === "\\") i += 1;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}" && --depth === 0) end = i;
    }
    if (end < 0) {
      unbalanced += 1;
      at = text.indexOf("{", at + 1);
    } else {
      found.push(text.slice(at, end + 1));
      at = text.indexOf("{", end + 1);
    }
  }
  return found;
}

const isExportDocument = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && (value.format === GROK_EXPORT_FORMAT || value.format === OLD_EXPORT_FORMAT || Array.isArray(value.bots));
const looksLikeBot = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Boolean(str(value.name)) && ["instructions", "memories", "user_facts", "skills", "routines", "apps"].some((key) => key in value);

/** Inside a reply only export-shaped objects count: an example list of routines is not a Bot. A file that is nothing but
 * JSON may also be a bare Bot or a bare list of Bots. Repairs run only once the text as written has found nothing. */
function documentsIn(text: string): Array<Record<string, unknown>> {
  const repaired = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  for (const version of repaired === text ? [text] : [text, repaired]) {
    const whole = looseJson(version.trim());
    if (isExportDocument(whole)) return [whole];
    if (looksLikeBot(whole)) return [{ bots: [whole] }];
    if (Array.isArray(whole) && whole.length && whole.every(looksLikeBot)) return [{ bots: whole }];
    const documents = bracedObjects(version).map(looseJson).filter(isExportDocument);
    if (documents.length) return documents;
  }
  return [];
}

function readApp(app: unknown): GrokApp[] {
  const record = isRecord(app) ? app : {};
  const name = typeof app === "string" ? app.trim() : first(record.name, record.label, record.id, record.slug);
  const headers = isRecord(record.headers) ? Object.keys(record.headers) : [];
  const env = [record.env, record.environment].flatMap((slot) => (isRecord(slot) ? Object.keys(slot) : []));
  return name ? [{
    name: oneLine(name),
    mcpUrl: first(record.mcp_url, record.mcpUrl, record.url),
    transport: first(record.transport, record.type).toLowerCase(),
    headerNames: [...new Set([...strings(record.header_names), ...headers])],
    envNames: [...new Set(env)],
  }] : [];
}

/** The current shape, and the fields the earlier openmaus.grok/1 prompt asked for. */
function readBot(bot: Record<string, unknown>): GrokBot {
  return {
    name: oneLine(first(bot.name)),
    title: oneLine(first(bot.title)),
    description: first(bot.description),
    instructions: first(bot.instructions, bot.soul, bot.systemPrompt),
    memories: strings(bot.memories),
    userFacts: strings(bot.user_facts ?? bot.userFacts),
    skills: list(bot.skills).flatMap((skill) => {
      if (typeof skill === "string") return [{ name: skill.trim(), description: "", instructions: "" }];
      return isRecord(skill) ? [{
        name: first(skill.name, skill.title),
        description: first(skill.description, skill.summary),
        instructions: first(skill.instructions, skill.body, skill.content, skill.text),
      }] : [];
    }),
    routines: list(bot.routines).flatMap((routine) => (isRecord(routine) ? [{
      name: first(routine.name, routine.title),
      instruction: first(routine.instruction, routine.prompt, routine.instructions, routine.task),
      trigger: first(routine.trigger).toLowerCase(),
      cron: first(routine.schedule_cron, routine.cron, routine.cronExpression),
      when: first(routine.schedule_text, routine.schedule, routine.when),
      timeZone: first(routine.timezone, routine.timeZone, routine.tz),
      paused: routine.paused === true,
      skills: strings(routine.skills),
      details: first(routine.trigger_details, routine.details),
    }] : [])),
    apps: list(bot.apps ?? bot.plugins ?? bot.integrations).flatMap(readApp),
  };
}

function redactStrings<T>(value: T): T {
  if (typeof value === "string") return redactSecretsInText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactStrings(item)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactStrings(child)])) as T;
  return value;
}

/** One Bot per name: lists are joined dropping only exact repeats (two different routines may share a name) and other
 * fields keep the last non-empty value, so a split or repeated export imports each thing once. */
export function mergeGrokBots(bots: readonly GrokBot[]): GrokBot[] {
  const merged = new Map<string, GrokBot>();
  for (const bot of bots) {
    const key = bot.name.toLowerCase();
    const into = merged.get(key);
    if (!into) {
      merged.set(key, structuredClone(bot));
      continue;
    }
    const union = <T,>(mine: T[], theirs: T[]) => [...new Map([...mine, ...theirs].map((item) => [JSON.stringify(item), item])).values()];
    merged.set(key, {
      name: into.name,
      title: bot.title || into.title,
      description: bot.description || into.description,
      instructions: bot.instructions || into.instructions,
      memories: union(into.memories, bot.memories),
      userFacts: union(into.userFacts, bot.userFacts),
      skills: union(into.skills, bot.skills),
      routines: union(into.routines, bot.routines),
      apps: union(into.apps, bot.apps),
    });
  }
  return [...merged.values()];
}

/** The Bots in a reply or file: a bare document, a fenced one, or several with chat text around them. A document with
 * credential-looking keys is refused whole, and token-shaped text anywhere else is redacted, before anything uses it. */
export function parseGrokExport(text: string): GrokBot[] {
  if (text.length > GROK_EXPORT_MAX_CHARS) throw new GrokImportError("tooLarge");
  const documents = documentsIn(text.replace(/^﻿/, ""));
  if (!documents.length) throw new GrokImportError(text.split("{").length > text.split("}").length ? "cutOff" : "notExport");
  const refused = documents.flatMap((document) => credentialKeys(document));
  if (refused.length) throw new GrokImportError("credentials", refused.slice(0, 5));
  if (documents.some((document) => typeof document.version === "number" && document.version > 1)) throw new GrokImportError("newerVersion");
  const raw = documents.flatMap((document) => (Array.isArray(document.bots) ? document.bots.filter(isRecord) : [document]));
  const bots = mergeGrokBots(raw.map(readBot).filter((bot) => bot.name).map((bot) => redactStrings(bot)));
  if (!bots.length) throw new GrokImportError("notExport");
  return bots;
}

/** Pieces of a Bot's text that looked like a key and were taken out. */
export const grokRedactions = (bot: GrokBot) => JSON.stringify(bot).match(/«redacted \d+ chars»/g)?.length ?? 0;

/** Text that says it is a Grok Bot export (it may still be malformed). */
export const mentionsGrokExport = (text: string) => text.includes(GROK_EXPORT_FORMAT) || text.includes(OLD_EXPORT_FORMAT);

const slug = (value: string, max: number) =>
  value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

function uniqueSlug(value: string, fallback: string, taken: Set<string>, max = 64): string {
  const base = slug(value, max - 3) || fallback;
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/** FNV-1a: a short stable suffix and colour pick, not a security boundary. */
function shortHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}

function fitBytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  let end = Math.min(text.length, max);
  while (end > 0 && utf8Bytes(text.slice(0, end)) > max) end = Math.floor(end * 0.95);
  return text.slice(0, end);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const EVENT_WORDS = /\b(?:when|whenever|each time|every time|on (?:new|each|every)|webhook|mention(?:ed|s)?|incoming|arrives?|opens?|merged?|pushed?)\b/i;
const CLOCK_TRIGGERS = new Set(["", "schedule", "scheduled", "time", "cron", "interval"]);

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

/** The schedule, in the routine's own zone. `movedZone`: it named a zone nothing here can read, so it runs in the person's. */
function routineSchedule(routine: GrokRoutine, timeZone: string): { schedule: PackageRoutineSchedule; movedZone: boolean } | null {
  const expression = routine.cron || (looksLikeCron(routine.when) ? routine.when : "");
  for (const zone of expression ? [routine.timeZone || timeZone, timeZone] : []) {
    try {
      return { schedule: normalizeCronSchedule({ type: "cron", expression, timeZone: zone }), movedZone: zone !== (routine.timeZone || timeZone) };
    } catch {
      // the next zone, then the plain words
    }
  }
  const daily = simpleDaily(routine.when);
  return daily ? { schedule: daily, movedZone: false } : null;
}

function skillEntry(skill: GrokSkill, name: string): { name: string; description: string; instructions: string } | null {
  const stripped = skill.instructions.replace(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/, "");
  const fromFrontmatter = skill.instructions === stripped ? "" : (parseSkillMd(skill.instructions) as { description?: string }).description ?? "";
  const body = stripped.trim();
  if (!body) return null;
  const description = clip(oneLine(skill.description || fromFrontmatter || body.split("\n").find((line) => line.trim())!.replace(/^#+\s*/, "")), 1_024);
  const instructions = `---\nname: ${name}\ndescription: ${yamlFrontmatterValue(description)}\n---\n\n${body}\n`;
  if (utf8Bytes(instructions) > SKILL_FILE_MAX_BYTES) return null;
  const parsed = parseSkillMd(instructions);
  return "error" in parsed || parsed.description !== description ? null : { name, description, instructions };
}

const SECRET_QUERY_PARAM = /key|token|secret|pass|auth|sig|session|credential/i;
/** A path segment this long and mixed reads as a key: such an address cannot be carried without carrying the key. */
const KEY_LIKE_SEGMENT = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9_-]{24,}$/;

/** A remote server address with any key taken out. `https` only: a Bot's export has no business pointing at this
 * computer or at a plain-text address. */
function serverAddress(raw: string): { url: string; stripped: string[] } | "insecure" | "keyInAddress" {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "insecure";
  }
  if (url.protocol !== "https:") return "insecure";
  const stripped: string[] = [];
  if (url.username || url.password) stripped.push("sign-in in the address");
  url.username = "";
  url.password = "";
  for (const name of Array.from(url.searchParams.keys())) {
    if (!SECRET_QUERY_PARAM.test(name)) continue;
    stripped.push(name);
    url.searchParams.delete(name);
  }
  const text = url.toString();
  const redactedEarlier = /«redacted|%C2%ABredacted/i.test(text);
  if (redactedEarlier || redactSecretsInText(text) !== text || url.pathname.split("/").some((part) => KEY_LIKE_SEGMENT.test(part))) return "keyInAddress";
  return { url: text, stripped };
}

const VALID_HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export type GrokNote =
  | { kind: "instructionsCut" | "memoriesTooBig" }
  | { kind: "skillLimit" | "skillUnreadable" | "skillEmpty" | "routineEmpty" | "routineMovedZone" | "appLimit" | "serverInsecure" | "serverKeyInAddress" | "serverLimit"; name: string };

/** A routine the import cannot run as it was: its full text goes to the person, to rebuild. */
export interface GrokRebuild { name: string; trigger: string; details: string; when: string; instruction: string; reason: "event" | "schedule" | "limit" }

export interface GrokMovePlan {
  name: string;
  title: string;
  instructions: string;
  document: PackageDocument;
  skills: string[];
  routines: Array<{ name: string; when: string; timeZone: string; pausedThere: boolean }>;
  /** A webhook routine maps onto a webhook automation; it is created paused, with a new address. */
  webhooks: Array<{ name: string; prompt: string; details: string; pausedThere: boolean }>;
  rebuild: GrokRebuild[];
  memories: string[];
  servers: Array<{ name: string; url: string; values: string[] }>;
  /** Apps with no address to carry: the person signs in to them here. */
  apps: string[];
  notes: GrokNote[];
}

const sameFact = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
const dedupe = (lines: string[], seen: Set<string>) => lines.filter((line) => {
  const key = sameFact(line);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

function memoryNotes(bot: GrokBot): { lines: string[]; text: string | null } {
  const seen = new Set<string>();
  const facts = dedupe(bot.memories.map((line) => line.replace(/\s*\n\s*/g, " ")), seen);
  const about = dedupe(bot.userFacts.map((line) => line.replace(/\s*\n\s*/g, " ")), seen);
  const lines = [...facts, ...about];
  if (!lines.length) return { lines, text: null };
  const part = (heading: string, items: string[]) => (items.length ? `## ${heading}\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n` : "");
  return { lines, text: `# Notes from Grok Bot\n\n${part("What I remember", facts)}${part("About the person", about)}`.trimEnd() + "\n" };
}

/** One Grok Bot as one bot in an openmaus.package v2 file, with everything the person is told about it. */
export function grokMovePlan(bot: GrokBot, options: { timeZone?: string } = {}): GrokMovePlan {
  const timeZone = options.timeZone?.trim() || "UTC";
  const notes: GrokNote[] = [];
  const name = clip(bot.name || "Grok Bot", 100);
  const agentKey = slug(name, 60) || "grok-bot";

  let soul = bot.instructions.trim();
  if (utf8Bytes(soul) > BOT_PROFILE_LIMITS.soul) {
    soul = fitBytes(soul, BOT_PROFILE_LIMITS.soul);
    notes.push({ kind: "instructionsCut" });
  }

  const skillNames = new Set<string>();
  const skillSlugs = new Map<string, string>();
  const skills: Array<NonNullable<ReturnType<typeof skillEntry>>> = [];
  const shownSkills: string[] = [];
  for (const [index, skill] of bot.skills.entries()) {
    const label = oneLine(skill.name) || String(index + 1);
    if (skills.length >= AGENT_MAX_SKILLS) {
      notes.push({ kind: "skillLimit", name: label });
      continue;
    }
    if (!skill.instructions.trim()) {
      notes.push({ kind: "skillEmpty", name: label });
      continue;
    }
    const entry = skillEntry(skill, uniqueSlug(skill.name, `skill-${index + 1}`, skillNames));
    if (!entry) {
      notes.push({ kind: "skillUnreadable", name: label });
      continue;
    }
    skills.push(entry);
    shownSkills.push(label);
    skillSlugs.set(skill.name.trim().toLowerCase(), entry.name);
  }

  const routineKeys = new Set<string>();
  const routines: NonNullable<PackageDocument["package"]["routines"]> = [];
  const plan: Pick<GrokMovePlan, "routines" | "webhooks" | "rebuild"> = { routines: [], webhooks: [], rebuild: [] };
  for (const [index, routine] of bot.routines.entries()) {
    const label = clip(oneLine(routine.name) || `Routine ${index + 1}`, 80);
    if (!routine.instruction) {
      notes.push({ kind: "routineEmpty", name: label });
      continue;
    }
    const usesSkills = routine.skills.flatMap((skill) => skillSlugs.get(skill.toLowerCase()) ?? []);
    const prompt = `${routine.instruction}${usesSkills.length ? `\n\nUse these skills: ${usesSkills.join(", ")}.` : ""}`.slice(0, 20_000);
    const rebuild = (reason: GrokRebuild["reason"]) =>
      plan.rebuild.push({ name: label, trigger: routine.trigger, details: routine.details, when: routine.when, instruction: routine.instruction, reason });
    const event = !CLOCK_TRIGGERS.has(routine.trigger) || (!routine.trigger && !routine.cron && EVENT_WORDS.test(routine.when));
    if (event) {
      if (routine.trigger === "webhook") plan.webhooks.push({ name: label, prompt, details: routine.details, pausedThere: routine.paused });
      else rebuild("event");
      continue;
    }
    const timing = routineSchedule(routine, timeZone);
    if (!timing) {
      rebuild("schedule");
      continue;
    }
    if (routines.length >= MAX_ROUTINES) {
      rebuild("limit");
      continue;
    }
    if (timing.movedZone) notes.push({ kind: "routineMovedZone", name: label });
    routines.push({
      key: uniqueSlug(label, `routine-${index + 1}`, routineKeys),
      name: label,
      agent: agentKey,
      prompt,
      runOn: "maus",
      schedule: timing.schedule,
      durationMinutes: 30,
      enabledAfterInstall: false,
    });
    plan.routines.push({ name: label, when: routine.when || routine.cron, timeZone: timing.movedZone ? timeZone : routine.timeZone || timeZone, pausedThere: routine.paused });
  }

  const connectionKeys = new Set<string>();
  const connections: NonNullable<PackageDocument["package"]["connections"]> = [];
  const servers: GrokMovePlan["servers"] = [];
  const appSlugs = new Set<string>();
  const requiredApps: PackageDocument["package"]["requirements"]["apps"] = [];
  const signInApps: string[] = [];
  for (const app of bot.apps) {
    const label = clip(app.name, 100);
    const address = app.mcpUrl ? serverAddress(app.mcpUrl) : null;
    if (address === "insecure" || address === "keyInAddress") {
      notes.push({ kind: address === "insecure" ? "serverInsecure" : "serverKeyInAddress", name: label });
      continue;
    }
    if (address) {
      if (connections.length >= PACKAGE_MAX_CONNECTIONS) {
        notes.push({ kind: "serverLimit", name: label });
        continue;
      }
      const key = uniqueSlug(`${/^[a-z]/i.test(label) ? "" : "server-"}${label}`, `server-${connections.length + 1}`, connectionKeys, 28);
      const headers = app.headerNames.filter((header) => VALID_HEADER.test(header)).slice(0, 32);
      connections.push({
        key,
        label,
        reason: clip(`${name} used ${label} in Grok Bot.`, 240),
        mcp: { transport: app.transport === "sse" || /\/sse\/?$/.test(new URL(address.url).pathname) ? "sse" : "http", url: address.url, valueNames: headers },
      });
      servers.push({ name: label, url: address.url, values: [...new Set([...app.headerNames, ...app.envNames, ...address.stripped])] });
      continue;
    }
    const appSlug = slug(label, 60);
    if (!appSlug || appSlugs.has(appSlug)) continue;
    if (appSlugs.size >= MAX_APPS) {
      notes.push({ kind: "appLimit", name: label });
      continue;
    }
    appSlugs.add(appSlug);
    requiredApps.push({ slug: appSlug, label, reason: clip(`${name} used ${label} in Grok Bot.`, 240) });
    signInApps.push(label);
  }

  const memory = memoryNotes(bot);
  let seed: { memory: Record<string, string> } | undefined;
  if (memory.text && utf8Bytes(memory.text) <= SEED_FILE_MAX_BYTES) seed = { memory: { "MEMORY.md": memory.text } };
  else if (memory.text) notes.push({ kind: "memoriesTooBig" });

  const description = bot.description.trim();
  const summary = clip(description || bot.title || `${name}, brought over from Grok Bot.`, 2_000);
  const hash = shortHash(`${name}\n${soul}`);
  const draft: PackageDocument = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    package: {
      id: `${agentKey}-${hash.toString(16).padStart(8, "0").slice(0, 6)}`,
      release: "1.0.0",
      name,
      tagline: clip(oneLine(summary), 160),
      summary,
      category: "Imported",
      author: { name: "Grok Bot" },
      license: "See source",
      outcomes: [clip(`${name} runs in OpenMausBot with your own engine and apps.`, 240)],
      setupMinutes: 5,
      requirements: { apps: requiredApps, capabilities: [] },
      team: { name: clip(name, 60) },
      agents: [{
        key: agentKey,
        name,
        ...(bot.title ? { title: clip(bot.title, 200) } : {}),
        ...(description ? { description: clip(description, 4_000) } : {}),
        ...(soul ? { soul } : {}),
        appearance: { color: BOT_COLORS[hash % BOT_COLORS.length]! },
        ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
        ...(connections.length ? { connections: connections.map((connection) => connection.key) } : {}),
        ...(seed ? { seed } : {}),
      }],
      ...(routines.length ? { routines } : {}),
      ...(connections.length ? { connections } : {}),
      ...(skills.length ? { skills: { version: 1 as const, entries: skills } } : {}),
    },
  };
  let document: PackageDocument;
  try {
    document = parsePackageDocument(draft, { trust: "file" });
  } catch {
    throw new GrokImportError("unusable");
  }
  return {
    name, title: bot.title, instructions: soul, document, skills: shownSkills, ...plan,
    memories: seed ? memory.lines : [], servers, apps: signInApps, notes,
  };
}

/** Routines the Bot's chat announced that its export does not have, by the same slug either side would get. */
export function routinesLeftOut(bot: GrokBot, announced: readonly string[]): string[] {
  const have = new Set(bot.routines.map((routine) => slug(routine.name, 64)));
  return announced.filter((name) => !have.has(slug(name, 64)));
}
