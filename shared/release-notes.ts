// What each app release brought, for the Announcements page: announcements/releases.json on main, delivered like the
// announcement cards (server/announcements/feed.ts). Each release is a version, a date and a few titled sections of
// short lines. A line is plain text with two marks only, **bold** and `code`; the app draws them itself, never as HTML,
// and a line with a tag, a link or an address in it is refused. scripts/release-notes-feed.mjs turns a release's
// Markdown notes into an entry with `releaseFromMarkdown`, which drops everything else.
import { z } from "zod";

import { compareVersions } from "./announcements.ts";

export const RELEASES_FILE = "announcements/releases.json";
export const RELEASES_SCHEMA_FILE = "announcements/releases.schema.json";
export const RELEASES_URL = `https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/${RELEASES_FILE}`;

/** The file keeps the newest this many releases; an install reads at most this many. */
export const MAX_RELEASES = 20;
export const RELEASE_LIMITS = { sectionTitle: 60, item: 600, sections: 16, items: 40 } as const;
/** A section for lines the notes give before any heading. */
export const DEFAULT_SECTION = "Highlights";

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
// Control characters, and the ones that reorder or hide text (bidi overrides and isolates, zero-width joiners).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/u;
const FORBIDDEN_ALL = new RegExp(FORBIDDEN_CHARS.source, "gu");
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface ReleaseMark { text: string; bold: boolean; code: boolean }

/** Where a line's `code` runs are: [start, end] of each pair of backticks. */
function codeRuns(line: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let at = line.indexOf("`"); at !== -1;) {
    const end = line.indexOf("`", at + 1);
    if (end === -1) break;
    if (end > at + 1) runs.push([at, end]);
    at = line.indexOf("`", end + 1);
  }
  return runs;
}

/** A line as the app draws it: runs of plain, **bold** and `code` text (code may sit inside bold). A mark without its
 * pair stays as the characters it is. */
export function releaseLineParts(line: string): ReleaseMark[] {
  const runs = codeRuns(line);
  const inCode = (at: number) => runs.some(([start, end]) => at >= start && at <= end);
  const toggles: number[] = [];
  for (let at = line.indexOf("**"); at !== -1; at = line.indexOf("**", at)) {
    if (inCode(at)) { at += 1; continue; }
    toggles.push(at);
    at += 2;
  }
  if (toggles.length % 2) toggles.pop();
  const parts: ReleaseMark[] = [];
  const push = (text: string, bold: boolean, code: boolean) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && !code && !last.code && last.bold === bold) last.text += text;
    else parts.push({ text, bold, code });
  };
  let bold = false, plain = "";
  for (let at = 0; at < line.length;) {
    const run = runs.find(([start]) => start === at);
    if (run) {
      push(plain, bold, false); plain = "";
      push(line.slice(run[0] + 1, run[1]), bold, true);
      at = run[1] + 1;
    } else if (toggles.includes(at)) {
      push(plain, bold, false); plain = "";
      bold = !bold;
      at += 2;
    } else {
      plain += line[at];
      at += 1;
    }
  }
  push(plain, bold, false);
  return parts;
}

/** The words of a line without its marks. */
export const releaseLineText = (line: string) => releaseLineParts(line).map((part) => part.text).join("");

/** What makes a line unfit to show, outside its `code` runs: a tag, a link or a web address, a script address. */
function lineProblem(line: string): string | null {
  if (FORBIDDEN_CHARS.test(line)) return "control or direction characters";
  if (line.trim() !== line) return "leading or trailing spaces";
  const words = releaseLineParts(line).filter((part) => !part.code).map((part) => part.text).join(" ");
  if (/[<>]/.test(words)) return "no tags or angle brackets";
  if (/\]\(|:\/\/|\b(?:javascript|vbscript)\s*:/i.test(words)) return "no links or addresses";
  if (/!\[|\[[^\]]*\]\s*\(/.test(words)) return "no links or pictures";
  return null;
}

const line = (max: number) => z.string().min(1).max(max).superRefine((value, context) => {
  const problem = lineProblem(value);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

type ObjectOf = typeof z.object;

function releaseSchema(strict: boolean) {
  const objectOf = strict ? (z.strictObject as unknown as ObjectOf) : z.object;
  return objectOf({
    version: z.string().regex(VERSION),
    date: z.iso.datetime({ offset: true }),
    sections: z.array(objectOf({
      title: line(RELEASE_LIMITS.sectionTitle),
      items: z.array(line(RELEASE_LIMITS.item)).min(1).max(RELEASE_LIMITS.items),
    })).min(1).max(RELEASE_LIMITS.sections),
  });
}

const strictRelease = releaseSchema(true);
const lenientRelease = releaseSchema(false);

export interface ReleaseSection { title: string; items: string[] }
export interface ReleaseEntry { version: string; date: string; sections: ReleaseSection[] }
export interface ReleaseFeed { version: 1; updatedAt: string; releases: ReleaseEntry[] }
export type ReleaseFeedResult = { ok: true; feed: ReleaseFeed; skipped: string[] } | { ok: false; error: string };

function outerSchema(strict: boolean, nowMs: number) {
  const objectOf = strict ? (z.strictObject as unknown as ObjectOf) : z.object;
  return objectOf({
    $schema: z.string().max(200).optional(),
    version: z.literal(1),
    updatedAt: z.iso.datetime({ offset: true }).refine((value) => Date.parse(value) <= nowMs + FUTURE_TOLERANCE_MS, "updatedAt is in the future"),
    releases: strict ? z.array(z.unknown()).max(MAX_RELEASES) : z.array(z.unknown()),
  });
}

/** For the JSON Schema beside the file (releases.schema.json), which editors read. CI keeps the two equal. */
export function releasesJsonSchema(): unknown {
  const feed = z.strictObject({
    $schema: z.string().max(200).optional(),
    version: z.literal(1),
    updatedAt: z.iso.datetime({ offset: true }),
    releases: z.array(strictRelease).max(MAX_RELEASES),
  });
  return z.toJSONSchema(feed, { target: "draft-2020-12", unrepresentable: "any" });
}

function issue(error: z.ZodError, where: string): string {
  const first = error.issues[0]!;
  return `${[where, ...first.path].filter((part) => part !== "").join(".")}: ${first.message}`;
}

export function parseRelease(value: unknown, options: { strict?: boolean } = {}): { ok: true; release: ReleaseEntry } | { ok: false; error: string } {
  const parsed = (options.strict ? strictRelease : lenientRelease).safeParse(value);
  if (!parsed.success) return { ok: false, error: issue(parsed.error, "release") };
  const { version, date, sections } = parsed.data;
  return { ok: true, release: { version, date, sections: sections.map(({ title, items }) => ({ title, items })) } };
}

/**
 * The whole file, as parseAnnouncementFeed reads the cards: a wrong outer shape refuses the file (the last good copy
 * stays); read leniently, a release that does not parse or repeats a version is skipped, and the newest MAX_RELEASES
 * are kept, newest first. `strict` (CI) refuses the file for any of those, and for releases out of order.
 */
export function parseReleaseFeed(value: unknown, options: { strict?: boolean; nowMs?: number } = {}): ReleaseFeedResult {
  const strict = options.strict === true;
  const outer = outerSchema(strict, options.nowMs ?? Date.now()).safeParse(value);
  if (!outer.success) return { ok: false, error: issue(outer.error, "") || "releases" };
  const releases: ReleaseEntry[] = [];
  const skipped: string[] = [];
  for (const [index, raw] of outer.data.releases.entries()) {
    const parsed = parseRelease(raw, { strict });
    const problem = !parsed.ok ? parsed.error
      : releases.some((entry) => entry.version === parsed.release.version) ? `release: ${parsed.release.version} is listed twice` : null;
    if (problem || !parsed.ok) {
      if (strict) return { ok: false, error: `releases.${index} ${problem}` };
      skipped.push(`releases.${index} ${problem}`);
      continue;
    }
    if (strict && releases.length && (compareVersions(parsed.release.version, releases[releases.length - 1]!.version) ?? 0) >= 0) {
      return { ok: false, error: `releases.${index} release: ${parsed.release.version} is not older than the one above it; newest first` };
    }
    releases.push(parsed.release);
  }
  releases.sort((a, b) => (compareVersions(b.version, a.version) ?? 0));
  return { ok: true, feed: { version: 1, updatedAt: outer.data.updatedAt, releases: releases.slice(0, MAX_RELEASES) }, skipped };
}

/** A release's first lines' leads, as plain sentences: the bold words a line opens with, else its first sentence. */
export function releaseLeads(release: Pick<ReleaseEntry, "sections">, count = 2): string[] {
  const leads: string[] = [];
  for (const item of release.sections.flatMap((section) => section.items)) {
    const bold = /^\*\*([^*]+?)\*\*/.exec(item)?.[1];
    let lead = (bold ?? /^(.+?[.!?])(\s|$)/.exec(releaseLineText(item))?.[1] ?? releaseLineText(item)).replace(/`/g, "").trim();
    lead = lead.replace(/[\s,;:–—-]+$/u, "");
    if (lead.length < 3) continue;
    if (!/[.!?…]$/.test(lead)) lead += ".";
    leads.push(lead);
    if (leads.length >= count) break;
  }
  return leads;
}

// ---- Markdown notes to an entry: what scripts/release-notes-feed.mjs writes, and the downloaded update's notes when the
// file does not list that version yet.

const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;

/** One line made fit to show: tags, links, pictures, addresses and emphasis other than **bold** and `code` dropped;
 * marks that do not pair dropped. Code runs keep their text. */
export function cleanReleaseLine(raw: string): string {
  const codes: string[] = [];
  let text = raw.replace(FORBIDDEN_ALL, " ")
    // A code run keeps its words; anything else that looks like markup goes.
    .replace(/`([^`\n]+)`/g, (_, code: string) => `\u0000${codes.push(code.replace(/`/g, "")) - 1}\u0000`);
  let before: string;
  do {
    before = text;
    text = text.replace(HTML_TAG, "");
  } while (text !== before);
  text = text
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\b(?:javascript|vbscript)\s*:\S*/gi, "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\[([^\]]*)\]/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*\w])\*(?!\*)([^*\n]+?)\*(?!\*)/g, "$1$2")
    .replace(/(^|\W)_([^_\n]+?)_(?=\W|$)/g, "$1$2");
  if ((text.match(/\*\*/g)?.length ?? 0) % 2) text = text.replace(/\*\*/g, "");
  text = text.replace(/\*\*\s*\*\*/g, "").replace(/(?<!\*)\*(?!\*)/g, "");
  // Spacing is tidied in the prose only; a code run keeps its text as written.
  text = text.replace(/\s+/g, " ").replace(/\(\s*\)/g, "").replace(/\s+([.,;:!?])/g, "$1").trim();
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `\`${codes[Number(index)]}\``);
  if (text.length > RELEASE_LIMITS.item) {
    const cut = text.slice(0, RELEASE_LIMITS.item - 1);
    const end = cut.search(/[.!?](?=[^.!?]*$)/);
    text = end > RELEASE_LIMITS.item / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
    if ((text.match(/\*\*/g)?.length ?? 0) % 2) text = text.replace(/\*\*/g, "");
    if ((text.match(/`/g)?.length ?? 0) % 2) text = text.replace(/`/g, "");
  }
  return lineProblem(text) === null ? text : "";
}

/** Lines that name a pull request or a contributor's handle, which the page leaves out. */
function credits(line: string): boolean {
  const words = line.replace(/`[^`]*`/g, "");
  return /(^|[\s(])#\d{2,}\b|\/pull\/\d+|\bby @[\w-]+|\bthanks?\b[^.]*@[\w-]+|@[\w-]+ (?:in|via) [#h]|\bcontributors?:\s*@/i.test(words);
}

/** Release notes as written (`### Section` headings, `- ` lines, nested `  - ` lines folded into theirs) to an entry. */
export function releaseFromMarkdown(markdown: string, { version, date }: { version: string; date: string }): ReleaseEntry {
  const sections: ReleaseSection[] = [];
  let section: ReleaseSection | null = null;
  let item: { parts: string[] } | null = null;
  const items: Array<{ section: ReleaseSection; parts: string[] }> = [];
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^#{3,6}\s+(.*)$/.exec(raw);
    if (heading) {
      section = { title: cleanReleaseLine(heading[1]!).replace(/\*\*|`/g, "").slice(0, RELEASE_LIMITS.sectionTitle).trim(), items: [] };
      sections.push(section);
      item = null;
      continue;
    }
    if (/^#{1,2}\s/.test(raw)) { item = null; continue; }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      if (bullet[1]!.length >= 2 && item) { item.parts.push(bullet[2]!); continue; }
      if (!section) { section = { title: DEFAULT_SECTION, items: [] }; sections.push(section); }
      item = { parts: [bullet[2]!] };
      items.push({ section, parts: item.parts });
      continue;
    }
    if (raw.trim() && /^\s/.test(raw) && item) item.parts.push(raw.trim());
    else item = null;
  }
  for (const { section: owner, parts } of items) {
    if (parts.some(credits)) continue;
    const text = cleanReleaseLine(parts.join(" "));
    if (text.length >= 3 && owner.items.length < RELEASE_LIMITS.items) owner.items.push(text);
  }
  const kept = sections.filter((entry) => entry.title && entry.items.length).slice(0, RELEASE_LIMITS.sections);
  return { version, date, sections: kept.length ? kept : [] };
}
