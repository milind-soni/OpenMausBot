// Refresh latest-mac.yml after notarization stapling rewrote the dmg and the
// updater zip: a stale sha512 makes electron-updater reject the download. The
// file list and its ORDER stay exactly as electron-builder wrote them
// (electron-updater filters it by arch on macOS, and the top-level path/sha512
// is the legacy fallback from the first entry); only sha512 and size are
// recomputed. Blockmaps go stale the same way: regenerate-blockmaps.mjs.
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
  if (line.startsWith("releaseDate:")) {
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
