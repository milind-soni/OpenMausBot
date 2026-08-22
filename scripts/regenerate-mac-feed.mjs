// Refresh latest-mac.yml after notarization stapling has changed the bytes.
//
// electron-builder writes latest-mac.yml during packaging, but the release
// flow then notarizes and STAPLES the dmg and the updater zip, which rewrites
// both files — so every hash in the feed is stale by the time it is published.
// Shipping the stale feed makes electron-updater reject the download (sha512
// mismatch) and every update falls back to a full manual reinstall.
//
// This keeps the file list and ORDER exactly as electron-builder wrote them —
// electron-updater filters that list by arch on macOS (files carrying an
// "arm64" marker on Apple silicon, the unmarked x64 ones on Intel), and the
// top-level path/sha512 is the legacy fallback taken from the first entry —
// and only recomputes sha512 + size from the bytes on disk right now.
//
// Blockmaps are NOT handled here: regenerate them separately with
// scripts/regenerate-blockmaps.mjs after stapling, for the same staleness reason.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedPath = process.argv[2] ?? join(root, "release", "latest-mac.yml");
const releaseDir = dirname(feedPath);

const sha512 = (file) => createHash("sha512").update(readFileSync(file)).digest("base64");

const original = readFileSync(feedPath, "utf8");
const lines = original.split("\n");

let currentUrl = null;
let firstUrl = null;
const out = lines.map((line) => {
  const url = line.match(/^\s*-\s+url:\s+(\S+)\s*$/);
  if (url) {
    currentUrl = url[1];
    firstUrl ??= currentUrl;
    return line;
  }
  // top-level path introduces the legacy fallback block: hash the first file
  if (/^path:\s+/.test(line)) {
    currentUrl = firstUrl;
    return `path: ${firstUrl}`;
  }
  if (currentUrl && /^\s*sha512:\s+/.test(line)) {
    const indent = line.match(/^\s*/)[0];
    return `${indent}sha512: ${sha512(join(releaseDir, currentUrl))}`;
  }
  if (currentUrl && /^\s*size:\s+/.test(line)) {
    const indent = line.match(/^\s*/)[0];
    return `${indent}size: ${statSync(join(releaseDir, currentUrl)).size}`;
  }
  if (/^sha512:\s+/.test(line)) {
    return `sha512: ${sha512(join(releaseDir, firstUrl))}`;
  }
  if (/^releaseDate:/.test(line)) {
    return `releaseDate: '${new Date().toISOString()}'`;
  }
  return line;
});

const updated = out.join("\n");
if (updated === original) {
  console.log("latest-mac.yml already matches the bytes on disk");
} else {
  writeFileSync(feedPath, updated);
}

// Refuse to end with a feed that lies: verify every entry against the disk.
const entries = [...updated.matchAll(/-\s+url:\s+(\S+)[\s\S]*?sha512:\s+(\S+)\n\s+size:\s+(\d+)/g)];
if (entries.length === 0) throw new Error("no file entries found in latest-mac.yml");
for (const [, url, hash, size] of entries) {
  const file = join(releaseDir, url);
  const actualHash = sha512(file);
  const actualSize = statSync(file).size;
  if (actualHash !== hash || actualSize !== Number(size)) {
    throw new Error(`feed mismatch for ${url}: hash/size do not match the file on disk`);
  }
  console.log(`  ok ${url} (${actualSize} bytes)`);
}
console.log(`latest-mac.yml verified against ${entries.length} artifacts`);
