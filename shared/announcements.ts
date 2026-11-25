// The announcements feed: cards the project publishes by editing announcements/announcements.json on main. The app
// downloads that file and draws each card itself with its own notice card; the file carries words, a picture's
// address, one of a few fixed button actions and who the card is for, never markup or code.
//
// The file is untrusted input, though it is ours: a bad merge reaches every install within the hour. So every text has
// a length limit and no control or direction characters, links are https only, buttons open an external page or one of
// the app's own places named below, pictures come from this repository's own folder, and a card the app cannot read
// fully is skipped. `strict` is what CI holds the file to (scripts/check-announcements.mjs); an install reads it
// leniently, so a field a later version adds never hides a card from this one, while an unknown kind, action or
// audience key does.
import { z } from "zod";

export const ANNOUNCEMENTS_FILE = "announcements/announcements.json";
export const ANNOUNCEMENTS_SCHEMA_FILE = "announcements/announcements.schema.json";
export const ANNOUNCEMENTS_URL = `https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/${ANNOUNCEMENTS_FILE}`;
/** Pictures: files in the repository's announcements/ folder on main, as raw.githubusercontent.com serves them. */
export const ANNOUNCEMENT_IMAGE_PREFIX = "https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/announcements/";

/** An install reads at most this many cards, in file order; CI refuses a longer list. */
export const MAX_CARDS = 20;
export const MAX_LOCALES = 16;
export const LIMITS = { id: 40, label: 16, title: 60, body: 240, button: 24, alt: 120, url: 500, bodyLines: 3 } as const;

export const ANNOUNCEMENT_KINDS = ["sponsor", "product", "tip"] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/** The app's own places a button may open. Each is something the app already opens from its own menus. */
export const ANNOUNCEMENT_PLACES = ["api_keys", "ai_engines", "connected_apps", "new_bot", "my_cloud"] as const;
export type AnnouncementPlace = (typeof ANNOUNCEMENT_PLACES)[number];
/** Places only someone who may change this place's settings can use: a card that opens one skips everyone else. */
export const ADMIN_PLACES: ReadonlySet<AnnouncementPlace> = new Set(["api_keys", "ai_engines", "new_bot"]);

/** Built-in marks a card may show beside its title instead of a picture. */
export const ANNOUNCEMENT_MARKS = ["claude", "codex", "grok", "kimi", "modelgo", "greenference", "deepseek", "copilot", "kiro"] as const;
export type AnnouncementMark = (typeof ANNOUNCEMENT_MARKS)[number];

export const ANNOUNCEMENT_PLATFORMS = ["mac", "windows", "linux", "ios", "android"] as const;
export type AnnouncementPlatform = (typeof ANNOUNCEMENT_PLATFORMS)[number];
/** `desktop`: the desktop app's own page. `cloud`: a MausBot Cloud's page, in a browser or in the desktop's window.
 * `server`: any other server's page, a self-hosted one or the app in a browser. */
export const ANNOUNCEMENT_SURFACES = ["desktop", "cloud", "server"] as const;
export type AnnouncementSurface = (typeof ANNOUNCEMENT_SURFACES)[number];
/** `none`: no MausBot Cloud plan of one's own (signed out, or a free account). `cloud`: a Cloud of one's own, or its
 * page. `team`: a Team Cloud's page. */
export const ANNOUNCEMENT_PLANS = ["none", "cloud", "team"] as const;
export type AnnouncementPlan = (typeof ANNOUNCEMENT_PLANS)[number];
/** `new`: nobody has had a reply on this place before this launch. `existing`: someone has. */
export const ANNOUNCEMENT_PEOPLE = ["new", "existing"] as const;
export type AnnouncementPeople = (typeof ANNOUNCEMENT_PEOPLE)[number];
/** Conditions the app reads from what it already has on screen; every one listed must hold. */
export const ANNOUNCEMENT_CONDITIONS = ["no_api_key", "one_bot_only", "no_routine"] as const;
export type AnnouncementCondition = (typeof ANNOUNCEMENT_CONDITIONS)[number];
/** The app's languages, as its language menu lists them (localeChoices). */
export const ANNOUNCEMENT_LOCALES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh", "zh-tw", "uk", "vi", "tr", "pl", "ru", "it", "ko"] as const;
export const AUDIENCE_KEYS = ["minVersion", "maxVersion", "platforms", "surfaces", "plans", "people", "languages", "when"] as const;

// Control characters, and the ones that reorder or hide text (bidi overrides and isolates, zero-width joiners).
// eslint-disable-next-line no-control-regex
const LINE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/u;
// eslint-disable-next-line no-control-regex
const BODY_FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/u;
const LOCALE_KEY = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const IMAGE_PATH = /^[a-z0-9][a-z0-9._/-]*\.(?:png|jpe?g|webp)$/;
/** Allows for a slow local clock, as the model manifest does. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** True for an https address with a host and nothing hidden in it: no user name or password, no spaces. */
export function isHttpsUrl(value: string): boolean {
  if (value.length > LIMITS.url || /\s/.test(value) || LINE_FORBIDDEN.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") && !url.hostname.endsWith(".");
  } catch {
    return false;
  }
}

export function isAnnouncementImageUrl(value: string): boolean {
  if (!isHttpsUrl(value) || !value.startsWith(ANNOUNCEMENT_IMAGE_PREFIX)) return false;
  const rest = value.slice(ANNOUNCEMENT_IMAGE_PREFIX.length);
  return IMAGE_PATH.test(rest) && !rest.split("/").some((part) => part === "" || part === "." || part === "..");
}

type ObjectOf = typeof z.object;

function oneText(max: number, body: boolean) {
  return z.string().min(1).max(max)
    .refine((value) => !(body ? BODY_FORBIDDEN : LINE_FORBIDDEN).test(value), "control or direction characters")
    .refine((value) => !body || value.split("\n").length <= LIMITS.bodyLines, `at most ${LIMITS.bodyLines} lines`)
    .refine((value) => value.trim() === value, "leading or trailing spaces");
}

/** Plain text: one string (English), or one per language with English among them. */
function text(max: number, strict: boolean, body = false) {
  const one = oneText(max, body);
  // partialRecord: a record keyed by an enum would need every language.
  const map = (strict ? z.partialRecord(z.enum(ANNOUNCEMENT_LOCALES), one) : z.record(z.string().regex(LOCALE_KEY), one)) as z.ZodType<Record<string, string>>;
  return z.union([
    one,
    map.refine((map) => Object.hasOwn(map, "en"), "needs an \"en\" text")
      .refine((map) => Object.keys(map).length <= MAX_LOCALES, `at most ${MAX_LOCALES} languages`),
  ]);
}
export type AnnouncementText = string | Record<string, string>;

const httpsUrl = z.string().max(LIMITS.url).refine(isHttpsUrl, "an https address");

/** Exactly one key, in every mode: anything else is an action this version cannot do. */
export const actionSchema = z.union([
  z.strictObject({ open_url: httpsUrl }),
  z.strictObject({ open: z.enum(ANNOUNCEMENT_PLACES) }),
]);
export type AnnouncementAction = z.infer<typeof actionSchema>;

function imageSchema(objectOf: ObjectOf, strict: boolean) {
  return z.union([
    objectOf({ url: z.string().max(LIMITS.url).refine(isAnnouncementImageUrl, `a .png, .jpg or .webp file under ${ANNOUNCEMENT_IMAGE_PREFIX}`), alt: text(LIMITS.alt, strict).optional() }),
    objectOf({ mark: z.enum(ANNOUNCEMENT_MARKS) }),
  ]);
}

function audienceSchema(strict: boolean) {
  const list = <const T extends readonly [string, ...string[]]>(values: T) =>
    strict ? z.array(z.enum(values)).min(1).max(values.length) : z.array(z.string().max(40)).min(1).max(40);
  const fields = {
    minVersion: strict ? z.string().regex(VERSION).optional() : z.string().max(40).optional(),
    maxVersion: strict ? z.string().regex(VERSION).optional() : z.string().max(40).optional(),
    platforms: list(ANNOUNCEMENT_PLATFORMS).optional(),
    surfaces: list(ANNOUNCEMENT_SURFACES).optional(),
    plans: list(ANNOUNCEMENT_PLANS).optional(),
    people: strict ? z.enum(ANNOUNCEMENT_PEOPLE).optional() : z.string().max(40).optional(),
    languages: strict ? z.array(z.enum(ANNOUNCEMENT_LOCALES)).min(1).max(ANNOUNCEMENT_LOCALES.length).optional() : z.array(z.string().max(40)).min(1).max(40).optional(),
    when: list(ANNOUNCEMENT_CONDITIONS).optional(),
  };
  // An install keeps a key it does not know, so the card then reaches no one rather than everyone.
  return strict ? z.strictObject(fields) : z.looseObject(fields);
}

function buttonSchema(objectOf: ObjectOf, strict: boolean) {
  return objectOf({ label: text(LIMITS.button, strict), action: actionSchema });
}

function cardSchema(strict: boolean) {
  const objectOf = strict ? (z.strictObject as unknown as ObjectOf) : z.object;
  return objectOf({
    id: z.string().min(3).max(LIMITS.id).regex(ID),
    kind: z.enum(ANNOUNCEMENT_KINDS),
    label: text(LIMITS.label, strict).optional(),
    title: text(LIMITS.title, strict),
    body: text(LIMITS.body, strict, true),
    // An install shows a card whose picture it cannot read without it; CI refuses the picture.
    image: strict ? imageSchema(objectOf, strict).optional() : z.unknown().optional(),
    primary: buttonSchema(objectOf, strict),
    secondary: buttonSchema(objectOf, strict).optional(),
    starts: z.iso.datetime({ offset: true }).optional(),
    ends: z.iso.datetime({ offset: true }),
    audience: audienceSchema(strict).optional(),
  }).refine((card) => card.starts === undefined || Date.parse(card.starts) < Date.parse(card.ends), "ends must be after starts");
}

const strictCard = cardSchema(true);
const lenientCard = cardSchema(false);
const lenientImage = imageSchema(z.object, false);

export type AnnouncementImage = { url: string; alt?: AnnouncementText } | { mark: AnnouncementMark };
export type AnnouncementCard = Omit<z.infer<typeof lenientCard>, "image" | "audience"> & {
  image?: AnnouncementImage;
  audience?: Record<string, unknown>;
};

function feedSchema(strict: boolean, nowMs: number) {
  const objectOf = strict ? (z.strictObject as unknown as ObjectOf) : z.object;
  return objectOf({
    $schema: z.string().max(200).optional(),
    version: z.literal(1),
    updatedAt: z.iso.datetime({ offset: true }).refine((value) => Date.parse(value) <= nowMs + FUTURE_TOLERANCE_MS, "updatedAt is in the future"),
    cards: strict ? z.array(z.unknown()).max(MAX_CARDS) : z.array(z.unknown()),
  });
}

/** For the JSON Schema beside the file (announcements.schema.json), which editors read. CI keeps the two equal. */
export function announcementsJsonSchema(): unknown {
  const feed = z.strictObject({
    $schema: z.string().max(200).optional(),
    version: z.literal(1),
    updatedAt: z.iso.datetime({ offset: true }),
    cards: z.array(strictCard).max(MAX_CARDS),
  });
  return z.toJSONSchema(feed, { target: "draft-2020-12", unrepresentable: "any" });
}

export interface AnnouncementFeed {
  version: 1;
  updatedAt: string;
  cards: AnnouncementCard[];
}

export type FeedResult =
  | { ok: true; feed: AnnouncementFeed; skipped: string[] }
  | { ok: false; error: string };

function issue(error: z.ZodError, where: string): string {
  const first = error.issues[0]!;
  return `${[where, ...first.path].filter((part) => part !== "").join(".")}: ${first.message}`;
}

/** One card, or why it was skipped. */
export function parseAnnouncementCard(value: unknown, options: { strict?: boolean } = {}): { ok: true; card: AnnouncementCard } | { ok: false; error: string } {
  const parsed = (options.strict ? strictCard : lenientCard).safeParse(value);
  if (!parsed.success) return { ok: false, error: issue(parsed.error, "card") };
  const { image, ...card } = parsed.data as z.infer<typeof lenientCard>;
  const picture = image === undefined ? undefined : lenientImage.safeParse(image);
  return { ok: true, card: { ...card, ...(picture?.success ? { image: picture.data as AnnouncementImage } : {}) } as AnnouncementCard };
}

/**
 * The whole file. A file whose outer shape is wrong is refused, so the last good copy stays. Read leniently, a card
 * that does not parse, or repeats an earlier card's id, is skipped and named in `skipped`, and only the first MAX_CARDS
 * are read; `strict` refuses the file for any of those instead.
 */
export function parseAnnouncementFeed(value: unknown, options: { strict?: boolean; nowMs?: number } = {}): FeedResult {
  const strict = options.strict === true;
  const outer = feedSchema(strict, options.nowMs ?? Date.now()).safeParse(value);
  if (!outer.success) return { ok: false, error: issue(outer.error, "") || "feed" };
  const cards: AnnouncementCard[] = [];
  const skipped: string[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of outer.data.cards.slice(0, MAX_CARDS).entries()) {
    const parsed = parseAnnouncementCard(raw, { strict });
    const problem = !parsed.ok ? parsed.error : ids.has(parsed.card.id) ? `card: the id ${parsed.card.id} is used twice` : null;
    if (problem) {
      if (strict) return { ok: false, error: `cards.${index} ${problem}` };
      skipped.push(`cards.${index} ${problem}`);
      continue;
    }
    if (parsed.ok) {
      ids.add(parsed.card.id);
      cards.push(parsed.card);
    }
  }
  return { ok: true, feed: { version: 1, updatedAt: outer.data.updatedAt, cards }, skipped };
}

/** Cards whose time has not passed, as a server hands them to its pages. */
export function liveCards(cards: readonly AnnouncementCard[], nowMs: number): AnnouncementCard[] {
  return cards.filter((card) => Date.parse(card.ends) > nowMs);
}

/** A text in `locale`, or its language without the region, or English. */
export function localized(value: AnnouncementText, locale: string): string {
  if (typeof value === "string") return value;
  const tag = locale.toLowerCase();
  return value[tag] ?? value[tag.split("-")[0]!] ?? value.en ?? "";
}

function versionParts(value: string): [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: string, b: string): number | null {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return 0;
}

/** What the app knows of the person and this page. `plan` is null while it is being read and undefined where this page
 * cannot know it; `platform` null when the browser does not say. */
export interface AnnouncementFacts {
  nowMs: number;
  version: string;
  platform: AnnouncementPlatform | null;
  surface: AnnouncementSurface;
  plan: AnnouncementPlan | null | undefined;
  people: AnnouncementPeople;
  locale: string;
  conditions: Readonly<Record<AnnouncementCondition, boolean>>;
}

const listed = (value: unknown): string[] | null => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;

/** True when the card is for these facts; false for an audience this version cannot read (an unknown key, a condition
 * it cannot check); null while a fact it needs is still loading. */
export function audienceMatches(audience: Record<string, unknown> | undefined, facts: AnnouncementFacts): boolean | null {
  if (!audience) return true;
  if (Object.keys(audience).some((key) => !(AUDIENCE_KEYS as readonly string[]).includes(key))) return false;
  const { minVersion, maxVersion, platforms, surfaces, plans, people, languages, when } = audience;
  if (minVersion !== undefined && !((compareVersions(facts.version, String(minVersion)) ?? -1) >= 0)) return false;
  if (maxVersion !== undefined && !((compareVersions(facts.version, String(maxVersion)) ?? 1) <= 0)) return false;
  const check = (value: unknown, fact: string | null | undefined): boolean => {
    const values = listed(value);
    return values !== null && fact !== null && fact !== undefined && values.includes(fact);
  };
  if (platforms !== undefined && !check(platforms, facts.platform)) return false;
  if (surfaces !== undefined && !check(surfaces, facts.surface)) return false;
  if (people !== undefined && people !== facts.people) return false;
  if (languages !== undefined) {
    const values = listed(languages), tag = facts.locale.toLowerCase();
    if (!values?.some((value) => value === tag || value === tag.split("-")[0])) return false;
  }
  if (when !== undefined) {
    const values = listed(when);
    if (!values || values.some((value) => !(ANNOUNCEMENT_CONDITIONS as readonly string[]).includes(value) || !facts.conditions[value as AnnouncementCondition])) return false;
  }
  if (plans !== undefined) {
    if (facts.plan === null) return null;
    if (!check(plans, facts.plan)) return false;
  }
  return true;
}

/** The places a card's buttons open. */
export function cardPlaces(card: AnnouncementCard): AnnouncementPlace[] {
  return [card.primary, card.secondary].flatMap((button) => button && "open" in button.action ? [button.action.open] : []);
}
