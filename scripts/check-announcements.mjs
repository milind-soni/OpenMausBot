// Validates announcements/announcements.json. Installs download that file from main within the hour, so CI holds it to
// the strict schema and the rules below, and refuses the edit before it can merge.
//
//   node scripts/check-announcements.mjs                  check the file
//   node scripts/check-announcements.mjs --against <rev>  also require updatedAt to move forward when the file changed
//   node scripts/check-announcements.mjs --write-schema   regenerate announcements/announcements.schema.json
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ANNOUNCEMENT_IMAGE_PREFIX, ANNOUNCEMENTS_FILE, ANNOUNCEMENTS_SCHEMA_FILE, announcementsJsonSchema, parseAnnouncementFeed,
} from "../shared/announcements.ts";

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

function main() {
  const { values } = parseArgs({ options: { against: { type: "string" }, "write-schema": { type: "boolean" } } });
  const schemaPath = join(root, ANNOUNCEMENTS_SCHEMA_FILE);
  if (values["write-schema"]) {
    writeFileSync(schemaPath, schemaText());
    console.log(`announcements: wrote ${ANNOUNCEMENTS_SCHEMA_FILE}`);
    return;
  }
  const problems = [];
  if (!existsSync(schemaPath) || lf(readFileSync(schemaPath, "utf8")) !== schemaText()) {
    problems.push(`${ANNOUNCEMENTS_SCHEMA_FILE} is out of date: run node scripts/check-announcements.mjs --write-schema`);
  }
  let previous = null;
  if (values.against) {
    try {
      previous = execFileSync("git", ["show", `${values.against}:${ANNOUNCEMENTS_FILE}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      console.log("announcements: no earlier copy to compare with");
    }
  }
  problems.push(...announcementProblems(readFileSync(join(root, ANNOUNCEMENTS_FILE), "utf8"), { previous }));
  if (problems.length) {
    for (const problem of problems) console.error(`announcements: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("announcements: valid");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
