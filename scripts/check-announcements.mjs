// Validates announcements/announcements.json and announcements/releases.json. Installs download both from main within the
// hour, so CI holds them to the strict schema and the rules below, and refuses the edit before it can merge.
//
//   node scripts/check-announcements.mjs                  check the file
//   node scripts/check-announcements.mjs --against <rev>  also require updatedAt to move forward when the file changed
//   node scripts/check-announcements.mjs --write-schema   regenerate both files' JSON Schemas
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ANNOUNCEMENT_IMAGE_PREFIX, ANNOUNCEMENTS_FILE, ANNOUNCEMENTS_SCHEMA_FILE, announcementsJsonSchema, parseAnnouncementFeed,
} from "../shared/announcements.ts";
import { cleanReleaseLine, parseReleaseFeed, RELEASES_FILE, RELEASES_SCHEMA_FILE, releasesJsonSchema } from "../shared/release-notes.ts";
import { MAX_RELEASES_FILE_BYTES } from "./release-notes-feed.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Half what an install reads (server/announcements/feed.ts), so a growing file fails here first. */
export const MAX_FILE_BYTES = 32 * 1024;
/** A card's picture, as the corner card shows it at most 268 pixels wide. */
export const MAX_IMAGE_BYTES = 200 * 1024;
/** No card stays up longer than this from the day it merges: a forgotten card ends on its own. */
export const MAX_DAYS_AHEAD = 180;
const DAY = 24 * 60 * 60 * 1000;

/** Line endings aside: a Windows checkout may turn LF into CRLF, which changes nothing an install reads. */
export const lf = (text) => text.replace(/\r\n/g, "\n");
export const schemaText = () => `${JSON.stringify(announcementsJsonSchema(), null, 2)}\n`;
export const releasesSchemaText = () => `${JSON.stringify(releasesJsonSchema(), null, 2)}\n`;

/** Problems with the file's text, or an empty list when it is sound. `fileSize(path)` is a picture's size in bytes, or null when
 * the repository has no such file. */
export function announcementProblems(raw, { previous: rawPrevious = null, now = Date.now(), fileSize = (path) => (existsSync(join(root, path)) ? statSync(join(root, path)).size : null) } = {}) {
  const text = lf(raw), previous = rawPrevious === null ? null : lf(rawPrevious);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return [`the file is larger than ${MAX_FILE_BYTES} bytes`];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ["the file is not valid JSON"];
  }
  const parsed = parseAnnouncementFeed(doc, { strict: true, nowMs: now });
  if (!parsed.ok) return [parsed.error];
  const problems = [];
  for (const card of parsed.feed.cards) {
    if (card.kind === "sponsor" && !card.label) problems.push(`${card.id}: a sponsor's card needs a label, such as "Sponsor", so people can tell it is one`);
    if (Date.parse(card.ends) > now + MAX_DAYS_AHEAD * DAY) problems.push(`${card.id}: ends is more than ${MAX_DAYS_AHEAD} days away`);
    if (card.image && "url" in card.image) {
      const path = `announcements/${card.image.url.slice(ANNOUNCEMENT_IMAGE_PREFIX.length)}`;
      const size = fileSize(path);
      if (size === null) problems.push(`${card.id}: the picture ${path} is not in the repository`);
      else if (size > MAX_IMAGE_BYTES) problems.push(`${card.id}: the picture ${path} is larger than ${MAX_IMAGE_BYTES} bytes`);
    }
  }
  if (previous !== null && text !== previous) {
    let before = null;
    try { before = parseAnnouncementFeed(JSON.parse(previous), { nowMs: now }); } catch {}
    if (before?.ok && Date.parse(parsed.feed.updatedAt) <= Date.parse(before.feed.updatedAt)) {
      problems.push("the file changed but updatedAt did not move forward; installs keep the copy with the newest updatedAt");
    }
  }
  return problems;
}

/** Problems with the release notes file: the strict schema, its size, every line already as the cleaner leaves it, and
 * updatedAt moving forward when it changed. */
export function releaseProblems(raw, { previous: rawPrevious = null, now = Date.now() } = {}) {
  const text = lf(raw), previous = rawPrevious === null ? null : lf(rawPrevious);
  if (Buffer.byteLength(text) > MAX_RELEASES_FILE_BYTES) return [`${RELEASES_FILE} is larger than ${MAX_RELEASES_FILE_BYTES} bytes`];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [`${RELEASES_FILE} is not valid JSON`];
  }
  const parsed = parseReleaseFeed(doc, { strict: true, nowMs: now });
  if (!parsed.ok) return [`${RELEASES_FILE}: ${parsed.error}`];
  const problems = [];
  for (const release of parsed.feed.releases) {
    for (const item of release.sections.flatMap((section) => section.items)) {
      if (cleanReleaseLine(item) !== item) problems.push(`${release.version}: a line has marks the app does not draw: ${item.slice(0, 80)}`);
    }
  }
  if (previous !== null && text !== previous) {
    let before = null;
    try { before = parseReleaseFeed(JSON.parse(previous), { nowMs: now }); } catch {}
    if (before?.ok && Date.parse(parsed.feed.updatedAt) <= Date.parse(before.feed.updatedAt)) {
      problems.push(`${RELEASES_FILE} changed but updatedAt did not move forward; installs keep the copy with the newest updatedAt`);
    }
  }
  return problems;
}

function main() {
  const { values } = parseArgs({ options: { against: { type: "string" }, "write-schema": { type: "boolean" } } });
  const schemas = [[ANNOUNCEMENTS_SCHEMA_FILE, schemaText], [RELEASES_SCHEMA_FILE, releasesSchemaText]];
  if (values["write-schema"]) {
    for (const [file, text] of schemas) {
      writeFileSync(join(root, file), text());
      console.log(`announcements: wrote ${file}`);
    }
    return;
  }
  const problems = [];
  for (const [file, text] of schemas) {
    const path = join(root, file);
    if (!existsSync(path) || lf(readFileSync(path, "utf8")) !== text()) problems.push(`${file} is out of date: run node scripts/check-announcements.mjs --write-schema`);
  }
  const earlier = (file) => {
    if (!values.against) return null;
    try {
      return execFileSync("git", ["show", `${values.against}:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      console.log(`announcements: no earlier copy of ${file} to compare with`);
      return null;
    }
  };
  problems.push(...announcementProblems(readFileSync(join(root, ANNOUNCEMENTS_FILE), "utf8"), { previous: earlier(ANNOUNCEMENTS_FILE) }));
  problems.push(...releaseProblems(readFileSync(join(root, RELEASES_FILE), "utf8"), { previous: earlier(RELEASES_FILE) }));
  if (problems.length) {
    for (const problem of problems) console.error(`announcements: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("announcements: valid");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
