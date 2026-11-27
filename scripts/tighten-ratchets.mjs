// Lowers the numbers in the ratchet tests to what the tree has now, so a pull request that shrinks a file never
// edits those lines. prepare-release.yml runs it on each release.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const SIZES = "scripts/testing/file-size-ratchet.test.ts";
const ROUTES = "scripts/testing/index-route-ratchet.test.ts";
const STORE_READS = "scripts/testing/store-read-ratchet.test.ts";
const LISTED_FROM = 1000;

/** The lines between `const <name> ... = {` and its closing `};`. */
function block(text, name) {
  const start = text.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`no ${name} in the ratchet test`);
  const open = text.indexOf("{\n", start) + 2;
  const close = text.indexOf("\n};", open);
  return { open, close };
}

/** `file` keeps the lower of its number and its line count; a file gone or under the list's threshold leaves it. */
export function tightenSizes(text, linesOf) {
  const { open, close } = block(text, "LINES");
  const changes = [];
  const lines = text.slice(open, close).split("\n").flatMap((line) => {
    const entry = /^(\s*)"([^"]+)": (\d+),$/.exec(line);
    if (!entry) return [line];
    const [, indent, file, written] = entry;
    const now = linesOf(file);
    if (now === null || now < LISTED_FROM) { changes.push(`${file}: removed (${now === null ? "gone" : `${now} lines`})`); return []; }
    if (now >= Number(written)) return [line];
    changes.push(`${file}: ${written} → ${now}`);
    return [`${indent}"${file}": ${now},`];
  });
  return { text: text.slice(0, open) + lines.join("\n") + text.slice(close), changes };
}

/** Each needle keeps the lower of its number and how often server/index.ts has it now. */
export function tightenRoutes(text, timesOf) {
  const { open, close } = block(text, "EXACT");
  const changes = [];
  const lines = text.slice(open, close).split("\n").map((line) => {
    const entry = /^(\s*)(['"])(.*)\2: (\d+),$/.exec(line);
    if (!entry) return line;
    const [, indent, quote, needle, written] = entry;
    const now = timesOf(needle);
    if (now >= Number(written)) return line;
    changes.push(`${needle}: ${written} → ${now}`);
    return `${indent}${quote}${needle}${quote}: ${now},`;
  });
  return { text: text.slice(0, open) + lines.join("\n") + text.slice(close), changes };
}

/** How many times a source file calls useStore(), under its own name or one it is imported as, its definition and
 * comments aside. */
export function storeReadsIn(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const names = ["useStore", ...[...code.matchAll(/\buseStore as (\w+)/g)].map((match) => match[1])];
  return names.reduce((sum, name) => sum + (code.match(new RegExp(`(?<!function )\\b${name}\\(\\)`, "g"))?.length ?? 0), 0);
}

/** Each file keeps the lower of its number and its calls now; a file gone or with none left leaves the list. */
export function tightenStoreReads(text, readsOf) {
  const { open, close } = block(text, "READS");
  const changes = [];
  const lines = text.slice(open, close).split("\n").flatMap((line) => {
    const entry = /^(\s*)"([^"]+)": (\d+),$/.exec(line);
    if (!entry) return [line];
    const [, indent, file, written] = entry;
    const now = readsOf(file);
    if (!now) { changes.push(`${file}: removed (${now === null ? "gone" : "no calls"})`); return []; }
    if (now >= Number(written)) return [line];
    changes.push(`${file}: ${written} → ${now}`);
    return [`${indent}"${file}": ${now},`];
  });
  return { text: text.slice(0, open) + lines.join("\n") + text.slice(close), changes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = (file) => new URL(file, ROOT);
  const linesOf = (file) => existsSync(path(file)) ? readFileSync(path(file), "utf8").split("\n").length - 1 : null;
  const index = readFileSync(path("server/index.ts"), "utf8");
  const sizes = tightenSizes(readFileSync(path(SIZES), "utf8"), linesOf);
  const routes = tightenRoutes(readFileSync(path(ROUTES), "utf8"), (needle) => index.split(needle).length - 1);
  const reads = tightenStoreReads(readFileSync(path(STORE_READS), "utf8"), (file) => existsSync(path(file)) ? storeReadsIn(readFileSync(path(file), "utf8")) : null);
  if (sizes.changes.length) writeFileSync(path(SIZES), sizes.text);
  if (routes.changes.length) writeFileSync(path(ROUTES), routes.text);
  if (reads.changes.length) writeFileSync(path(STORE_READS), reads.text);
  const changes = [...sizes.changes, ...routes.changes, ...reads.changes];
  for (const change of changes) console.log(change);
  if (!changes.length) console.log("ratchets already tight");
}
