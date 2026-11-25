// Adds one release's notes to announcements/releases.json, the list the Announcements page shows (docs/announcements.md).
// Run it once a release is published, never in its version-bump PR: main reaches installs within the hour, and a bump
// that never ships would list a release nobody can get.
//
//   node scripts/release-notes-feed.mjs 0.1.176 path/to/release-notes-v0.1.176.md
//   node scripts/release-notes-feed.mjs 0.1.176 notes.md --date 2026-11-22T10:00:00Z   the release's publish time (default: now)
//   node scripts/release-notes-feed.mjs 0.1.176 notes.md --file other.json              write another file (tests)
//
// The notes are the Markdown published as the GitHub release body: `### Section` headings and `- ` lines. Each line keeps
// only **bold** and `code`; tags, links, addresses and lines naming a pull request or a contributor's handle are dropped.
// The entry replaces one with the same version; the list stays newest first and keeps the latest MAX_RELEASES, fewer
// when that would pass MAX_FILE_BYTES.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { compareVersions } from "../shared/announcements.ts";
import { MAX_RELEASES, parseRelease, parseReleaseFeed, releaseFromMarkdown, RELEASES_FILE } from "../shared/release-notes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** What CI allows (scripts/check-announcements.mjs): three quarters of what an install reads (server/announcements/release-notes.ts). */
export const MAX_RELEASES_FILE_BYTES = 96 * 1024;

export const releasesText = (feed) => `${JSON.stringify(feed, null, 2)}\n`;

/** The file's new text with `entry` in it, or throws why it cannot be. `now` moves updatedAt forward. */
export function withRelease(raw, entry, { now = Date.now() } = {}) {
  const checked = parseRelease(entry, { strict: true });
  if (!checked.ok) throw new Error(`the notes for ${entry.version} do not make a valid entry (${checked.error})`);
  const parsed = parseReleaseFeed(JSON.parse(raw), { strict: true, nowMs: now });
  if (!parsed.ok) throw new Error(`${RELEASES_FILE} is invalid (${parsed.error})`);
  const previous = Date.parse(parsed.feed.updatedAt);
  const updatedAt = new Date(Math.max(Math.floor(now / 1000) * 1000, Math.floor(previous / 1000) * 1000 + 1000)).toISOString().replace(".000Z", "Z");
  const releases = [checked.release, ...parsed.feed.releases.filter((release) => release.version !== entry.version)]
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
    .slice(0, MAX_RELEASES);
  const feed = { $schema: "./releases.schema.json", version: 1, updatedAt, releases };
  while (Buffer.byteLength(releasesText(feed)) > MAX_RELEASES_FILE_BYTES && feed.releases.length > 1) feed.releases.pop();
  if (Buffer.byteLength(releasesText(feed)) > MAX_RELEASES_FILE_BYTES) throw new Error(`the notes for ${entry.version} alone are larger than ${MAX_RELEASES_FILE_BYTES} bytes`);
  if (!feed.releases.some((release) => release.version === entry.version)) throw new Error(`${entry.version} is older than every release the file keeps`);
  return releasesText(feed);
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { date: { type: "string" }, file: { type: "string" } } });
  const [version, notesPath] = positionals;
  if (!version || !notesPath || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: node scripts/release-notes-feed.mjs <version> <notes.md> [--date ISO] [--file path]");
    process.exitCode = 2;
    return;
  }
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (values.date !== undefined && !iso.test(values.date)) throw new Error(`--date ${values.date} is not an ISO date and time, such as 2026-11-22T10:00:00Z`);
  const date = values.date ? new Date(values.date) : new Date();
  if (Number.isNaN(date.getTime()) || (values.date && !values.date.startsWith(date.toISOString().slice(0, 10)) && values.date.endsWith("Z"))) {
    throw new Error(`--date ${values.date} is not a real date`);
  }
  const file = values.file ?? join(root, RELEASES_FILE);
  const entry = releaseFromMarkdown(readFileSync(notesPath, "utf8"), { version, date: date.toISOString().replace(/\.\d{3}Z$/, "Z") });
  writeFileSync(file, withRelease(readFileSync(file, "utf8"), entry));
  const lines = entry.sections.reduce((sum, section) => sum + section.items.length, 0);
  console.log(`release notes: ${version} added to ${values.file ?? RELEASES_FILE} (${entry.sections.length} sections, ${lines} lines)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
