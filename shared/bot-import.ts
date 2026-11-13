// Export parsing and credential refusal adapt an MIT-licensed importer; see NOTICE.
import {
  AGENT_MAX_SKILLS, PACKAGE_FORMAT, PACKAGE_MAX_CONNECTIONS, PACKAGE_VERSION, SEED_FILE_MAX_BYTES,
  parsePackageDocument, utf8Bytes, type PackageDocument, type PackageRoutineSchedule,
} from "./package-format.ts";
import { BOT_PROFILE_LIMITS } from "./bot-profile.ts";
import { redactSecretsInText } from "./redact.ts";
import { normalizeCronSchedule } from "./routine-schedule.ts";
import { parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES, yamlFrontmatterValue } from "./skill-md.ts";

export const BOT_EXPORT_MAX_CHARS = 4 * 1024 * 1024;
const MAX_ROUTINES = 50;
const BOT_COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const;
/** Failed brace matches before a reply stops being searched: each one scans to the end of the text. */
const MAX_UNBALANCED = 50;

export function botExportPrompt(format: string): string {
  return `I'm moving to another assistant and need a complete, machine-readable copy of your setup. Do not change, pause or delete anything.

Write one JSON document with exactly this shape, then save it as ${format}-<your name>.json (your name in lowercase, spaces as hyphens): in my Downloads folder if you can write to my computer, otherwise in your workspace, and attach it to your reply. If you cannot attach files, put the whole document in a single \`\`\`json code block instead.

{
  "format": "${format}",
  "version": 1,
  "bots": [
    {
      "name": "your name",
      "title": "your label/job title, or empty",
      "instructions": "your full role, job description and lasting rules, verbatim where you can",
      "memories": ["each thing you remember about the work, one string per fact"],
      "user_facts": ["each fact you know about me (name, time zone, preferences), one per string"],
      "skills": [
        {"name": "skill name", "description": "when to use it",
         "instructions": "the COMPLETE skill text, every step, rule and output format, verbatim"}
      ],
      "routines": [
        {"name": "routine name",
         "instruction": "the COMPLETE instruction the routine runs, verbatim",
         "trigger": "schedule | slack | github | linear | sentry | pagerduty | email | webhook | other",
         "schedule_cron": "5-field cron expression in the routine's time zone, e.g. 0 8 * * 1-5 (empty when not on a schedule)",
         "schedule_text": "When to run, in words, as the app shows it",
         "timezone": "IANA time zone, e.g. America/New_York",
         "paused": false,
         "skills": ["names of skills this routine uses"],
         "trigger_details": "for event triggers: channel, repository, phrase, senders, etc."}
      ],
      "apps": [{"name": "connected app or MCP server name", "mcp_url": "remote MCP URL if any, else empty"}]
    }
  ]
}

Rules: include EVERY routine you own (paused ones too) and EVERY skill enabled for you, with full text, not summaries. If you cannot read something (a routine's schedule, a skill's text), leave it out and tell me in your reply what you left out; never guess or fill it in from memory. Never include passwords, API keys, tokens, webhook keys, cookies or card numbers: leave those out entirely. Output valid JSON only (no comments).
If it is too long for one message or file, split it: send several documents, each complete and valid in this same shape with the same bot name, each holding the part the others do not. They are imported together.
`;
}

export type BotImportErrorCode = "notExport" | "cutOff" | "tooLarge" | "credentials" | "newerVersion" | "unusable";

export class BotImportError extends Error {
  readonly code: BotImportErrorCode;
  /** The credential-looking keys, for "credentials". */
  readonly keys: string[];
  constructor(code: BotImportErrorCode, keys: string[] = []) {
    super(code);
    this.name = "BotImportError";
    this.code = code;
    this.keys = keys;
  }
}

export interface ImportedSkill { name: string; description: string; instructions: string }
export interface ImportedRoutine {
  name: string; instruction: string; trigger: string; cron: string; when: string; timeZone: string;
  paused: boolean; skills: string[]; details: string;
}
export interface ImportedApp { name: string; mcpUrl: string; transport: string; headerNames: string[] }
export interface ImportedBot {
  name: string; title: string; description: string; instructions: string;
  memories: string[]; userFacts: string[]; skills: ImportedSkill[]; routines: ImportedRoutine[]; apps: ImportedApp[];
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

const isExportDocument = (value: unknown, formats: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && (formats.includes(String(value.format)) || Array.isArray(value.bots));
const looksLikeBot = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Boolean(str(value.name)) && ["instructions", "memories", "user_facts", "skills", "routines", "apps"].some((key) => key in value);

/** Inside a reply only export-shaped objects count: an example list of routines is not a Bot. A file that is nothing but
 * JSON may also be a bare Bot or a bare list of Bots. Repairs run only once the text as written has found nothing. */
function documentsIn(text: string, formats: readonly string[]): Array<Record<string, unknown>> {
  const repaired = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  for (const version of repaired === text ? [text] : [text, repaired]) {
    const whole = looseJson(version.trim());
    if (isExportDocument(whole, formats)) return [whole];
    if (looksLikeBot(whole)) return [{ bots: [whole] }];
    if (Array.isArray(whole) && whole.length && whole.every(looksLikeBot)) return [{ bots: whole }];
    const documents = bracedObjects(version).map(looseJson).filter((value) => isExportDocument(value, formats));
    if (documents.length) return documents;
  }
  return [];
}

function readApp(app: unknown): ImportedApp[] {
  const record = isRecord(app) ? app : {};
  const name = typeof app === "string" ? app.trim() : first(record.name, record.label, record.id, record.slug);
  return name ? [{
    name: oneLine(name),
    mcpUrl: first(record.mcp_url, record.mcpUrl, record.url),
    transport: first(record.transport, record.type).toLowerCase(),
    headerNames: isRecord(record.headers) ? Object.keys(record.headers) : [],
  }] : [];
}

/** Current export fields and aliases accepted from older exports. */
function readBot(bot: Record<string, unknown>): ImportedBot {
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
export function mergeImportedBots(bots: readonly ImportedBot[]): ImportedBot[] {
  const merged = new Map<string, ImportedBot>();
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
export function parseBotExport(text: string, formats: readonly string[]): ImportedBot[] {
  if (text.length > BOT_EXPORT_MAX_CHARS) throw new BotImportError("tooLarge");
  const documents = documentsIn(text.replace(/^﻿/, ""), formats);
  if (!documents.length) throw new BotImportError(text.split("{").length > text.split("}").length ? "cutOff" : "notExport");
  const refused = documents.flatMap((document) => credentialKeys(document));
  if (refused.length) throw new BotImportError("credentials", refused.slice(0, 5));
  if (documents.some((document) => typeof document.version === "number" && document.version > 1)) throw new BotImportError("newerVersion");
  const raw = documents.flatMap((document) => (Array.isArray(document.bots) ? document.bots.filter(isRecord) : [document]));
  const bots = mergeImportedBots(raw.map(readBot).filter((bot) => bot.name).map((bot) => redactStrings(bot)));
  if (!bots.length) throw new BotImportError("notExport");
  return bots;
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

const CLOCK_TRIGGERS = new Set(["", "schedule", "scheduled", "time", "cron", "interval"]);

/** The schedule in the routine's own zone, or the person's when it names one nothing here can read, from its cron or its
 * words when those are a cron. Null for anything else: a routine with no readable clock. */
function routineSchedule(routine: ImportedRoutine, timeZone: string): PackageRoutineSchedule | null {
  if (!CLOCK_TRIGGERS.has(routine.trigger)) return null;
  for (const expression of [routine.cron, routine.when].filter(Boolean)) {
    for (const zone of [routine.timeZone || timeZone, timeZone]) {
      try {
        return normalizeCronSchedule({ type: "cron", expression, timeZone: zone });
      } catch {
        // the next zone, then the words
      }
    }
  }
  return null;
}

function skillEntry(skill: ImportedSkill, name: string): { name: string; description: string; instructions: string } | null {
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

/** A remote server address with any key taken out, or null when it can't be carried without one. `https` only: a Bot's
 * export has no business pointing at this computer or at a plain-text address. */
function serverAddress(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  for (const name of Array.from(url.searchParams.keys())) {
    if (SECRET_QUERY_PARAM.test(name)) url.searchParams.delete(name);
  }
  const text = url.toString();
  const redactedEarlier = /«redacted|%C2%ABredacted/i.test(text);
  return redactedEarlier || redactSecretsInText(text) !== text || url.pathname.split("/").some((part) => KEY_LIKE_SEGMENT.test(part)) ? null : text;
}

const VALID_HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** Where a Bot's event routines are kept for rebuilding: a topic of the new bot's memory. */
export interface BotImportOrigin {
  name: string;
  notesFile: string;
  identityPrefix: string;
}

export interface BotMovePlan {
  name: string;
  packageId: string;
  document: PackageDocument;
  /** `folder` is the skill's name here. `on`: the skill scan passed it, so the move switches it on. */
  skills: Array<{ folder: string; name: string; on: boolean }>;
  routines: number;
  /** Routines not created, saved in GROK_NOTES_FILE: on an event, or with a schedule that can't be read. */
  notes: number;
  memories: number;
  /** Apps to connect again here: all but those whose server name is already here. */
  apps: number;
}

const sameFact = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
const dedupe = (lines: string[], seen: Set<string>) => lines.filter((line) => {
  const key = sameFact(line);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

function memoryNotes(bot: ImportedBot, sourceName: string): { count: number; text: string | null } {
  const seen = new Set<string>();
  const facts = dedupe(bot.memories.map((line) => line.replace(/\s*\n\s*/g, " ")), seen);
  const about = dedupe(bot.userFacts.map((line) => line.replace(/\s*\n\s*/g, " ")), seen);
  const count = facts.length + about.length;
  if (!count) return { count, text: null };
  const part = (heading: string, items: string[]) => (items.length ? `## ${heading}\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n` : "");
  return { count, text: `# Notes from ${sourceName}\n\n${part("What I remember", facts)}${part("About the person", about)}`.trimEnd() + "\n" };
}

function eventNotes(name: string, routines: readonly ImportedRoutine[], sourceName: string): string {
  const sections = routines.flatMap((routine) => [
    `## ${routine.name || "routine"}`, "",
    `- Trigger: ${routine.trigger || "unknown"}`,
    `- Details: ${routine.details || routine.when || "n/a"}`, "",
    routine.instruction, "",
  ]);
  return [`# ${name}: ${sourceName} routines that run on an event`, "",
    "These start on something happening instead of a schedule, so they were not turned into routines. Set up each one again here.", "",
    ...sections].join("\n");
}

/** One exported bot as one bot in an openmaus.package v2 file, and how much of it comes over. `takenServers` holds server names
 * already here: one of those is skipped, never overwritten or shared. */
export function botMovePlan(bot: ImportedBot, origin: BotImportOrigin, options: { timeZone?: string; takenServers?: ReadonlySet<string> } = {}): BotMovePlan {
  const sourceName = origin.name;
  const notesFile = origin.notesFile;
  const timeZone = options.timeZone?.trim() || "UTC";
  const name = clip(bot.name || sourceName, 100);
  const agentKey = slug(name, 60) || slug(sourceName, 60);
  const soul = fitBytes(bot.instructions.trim(), BOT_PROFILE_LIMITS.soul);

  const skillNames = new Set<string>();
  const skillSlugs = new Map<string, string>();
  const skills: Array<NonNullable<ReturnType<typeof skillEntry>>> = [];
  const planned: BotMovePlan["skills"] = [];
  for (const [index, skill] of bot.skills.entries()) {
    if (skills.length >= AGENT_MAX_SKILLS || !skill.instructions.trim()) continue;
    const entry = skillEntry(skill, uniqueSlug(skill.name, `skill-${index + 1}`, skillNames));
    if (!entry) continue;
    skills.push(entry);
    skillSlugs.set(skill.name.trim().toLowerCase(), entry.name);
    planned.push({ folder: entry.name, name: oneLine(skill.name) || String(index + 1), on: scanSkillText(entry.instructions).length === 0 });
  }

  const routineKeys = new Set<string>();
  const routineNames = new Set<string>();
  const routines: NonNullable<PackageDocument["package"]["routines"]> = [];
  const unscheduled: ImportedRoutine[] = [];
  for (const [index, routine] of bot.routines.entries()) {
    if (!routine.instruction) continue;
    const schedule = routineSchedule(routine, timeZone);
    if (!schedule) {
      unscheduled.push(routine);
      continue;
    }
    if (routines.length >= MAX_ROUTINES) continue;
    const label = oneLine(routine.name) || "routine";
    const base = clip(`${name}: ${label}`, 74);
    let jobName = base;
    for (let n = 2; routineNames.has(jobName); n += 1) jobName = `${base} (${n})`;
    routineNames.add(jobName);
    const usesSkills = routine.skills.flatMap((skill) => skillSlugs.get(skill.toLowerCase()) ?? []);
    routines.push({
      key: uniqueSlug(label, `routine-${index + 1}`, routineKeys),
      name: jobName,
      agent: agentKey,
      prompt: `${routine.instruction}${usesSkills.length ? `\n\nUse these skills: ${usesSkills.join(", ")}.` : ""}`.slice(0, 20_000),
      runOn: "maus",
      schedule,
      durationMinutes: 30,
      enabledAfterInstall: false,
    });
  }

  const memory = memoryNotes(bot, sourceName);
  const seed: Record<string, string> = {};
  if (memory.text && utf8Bytes(memory.text) <= SEED_FILE_MAX_BYTES) seed["MEMORY.md"] = memory.text;
  if (unscheduled.length) {
    const notes = eventNotes(name, unscheduled, sourceName);
    if (utf8Bytes(notes) <= SEED_FILE_MAX_BYTES) seed[notesFile] = notes;
  }

  const connectionKeys = new Set<string>();
  const connections: NonNullable<PackageDocument["package"]["connections"]> = [];
  let apps = 0;
  for (const app of bot.apps) {
    const label = clip(app.name, 100);
    const address = app.mcpUrl ? serverAddress(app.mcpUrl) : null;
    const proposed = slug(`${/^[a-z]/i.test(label) ? "" : "server-"}${label}`, 25) || `server-${connections.length + 1}`;
    if (address && options.takenServers?.has(proposed)) continue;
    apps += 1;
    if (!address || connections.length >= PACKAGE_MAX_CONNECTIONS) continue;
    connections.push({
      key: uniqueSlug(proposed, proposed, connectionKeys, 28),
      label,
      reason: clip(`${name} used ${label} in ${sourceName}.`, 240),
      mcp: { transport: app.transport === "sse" || /\/sse\/?$/.test(new URL(address).pathname) ? "sse" : "http", url: address, valueNames: app.headerNames.filter((header) => VALID_HEADER.test(header)).slice(0, 32) },
    });
  }

  const description = bot.description.trim();
  const summary = clip(description || bot.title || `${name}, brought over from ${sourceName}.`, 2_000);
  const hash = shortHash(`${origin.identityPrefix}${name}\n${soul}`);
  const packageId = `${agentKey}-${hash.toString(16).padStart(8, "0").slice(0, 6)}`;
  const draft: PackageDocument = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    package: {
      id: packageId,
      release: "1.0.0",
      name,
      tagline: clip(oneLine(summary), 160),
      summary,
      category: "Imported",
      author: { name: sourceName },
      license: "See source",
      outcomes: [clip(`${name} runs in OpenMausBot with your own engine and apps.`, 240)],
      setupMinutes: 5,
      requirements: { apps: [], capabilities: [] },
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
        ...(Object.keys(seed).length ? { seed: { memory: seed } } : {}),
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
    throw new BotImportError("unusable");
  }
  return {
    name, packageId, document, skills: planned, routines: routines.length,
    notes: seed[notesFile] ? unscheduled.length : 0,
    memories: seed["MEMORY.md"] ? memory.count : 0,
    apps,
  };
}
