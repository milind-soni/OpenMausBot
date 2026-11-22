// While the page holds a relay pairing (a phone browser away from home), its own server is reachable only through
// MausBot Relay, so every request the app makes goes through serverFetch (src/lib/relay-server.ts), which keeps any
// path outside /api a plain fetch. A bare fetch( in app code is a screen that breaks away from home.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);

/** App code: not tests, the relay itself, test rigs, or the preview pages that stand in a fake server for fetch. */
function appFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.|\.e2e\./.test(file) && !file.startsWith("src/testing/") && !file.startsWith("src/lib/e2e/"))
    .filter((file) => file !== "src/lib/relay-server.ts" && !file.endsWith("-preview.tsx"));
}

/** A call to fetch, whitespace or a line break before its `(` too, or fetch handed on as a value (`fetchImpl = fetch`,
 * `run(fetch)`, `impl ?? fetch`, `custom || fetch`, `return fetch`, `() => fetch`); not `.fetch(` or a `fetch:` key. */
const BARE_FETCH = /(?<![\w$.])fetch\s*\(|(?:[=(,:]|=>|\?\?|\|\||&&|\breturn)\s*fetch\b(?![\w$.(]|\s*[:(])/g;

/** The 1-based lines of `source` with a bare fetch, `//` comments left out. */
function bareFetchLines(source: string): number[] {
  const code = source.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  const lines = [...code.matchAll(BARE_FETCH)].map((match) => code.slice(0, match.index).split("\n").length);
  return [...new Set(lines)];
}

describe("app requests to its own server", () => {
  it("all go through serverFetch, never a bare fetch", () => {
    const bare = appFiles().flatMap((file) => bareFetchLines(readFileSync(new URL(file, ROOT), "utf8")).map((line) => `${file}:${line}`));
    expect(bare).toEqual([]);
  });

  it("counts a bare fetch however it is spaced, and nothing that only looks like one", () => {
    expect(bareFetchLines('fetch("/api/bots");')).toEqual([1]);
    expect(bareFetchLines('void fetch ("/api/bots");')).toEqual([1]);
    expect(bareFetchLines('const a = 1;\nawait fetch\n  ("/api/bots");')).toEqual([2]);
    expect(bareFetchLines("const run = fetch;\nuse(fetch)")).toEqual([1, 2]);
    expect(bareFetchLines('const impl = options.fetchImpl ?? fetch;\nconst alt = custom || fetch;')).toEqual([1, 2]);
    expect(bareFetchLines("function impl() { return fetch; }\nconst get = () => fetch;")).toEqual([1, 2]);
    expect(bareFetchLines('link.fetch("/api/bots");\nconst x = { fetch: go };\n// fetch("/api/bots")\nserverFetch("/api/bots");')).toEqual([]);
    expect(bareFetchLines("const UNREACHABLE = /Load failed|fetch failed$/i;")).toEqual([]);
  });
});
