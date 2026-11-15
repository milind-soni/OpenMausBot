import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { syncPhoneProtocol } from "./sync-phone-protocol.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./sync-phone-protocol.mjs", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const blob = (path) => execFileSync("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: ROOT });

const made = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-phone-protocol-sync-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(dir) {
  const files = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(dir, path).split("\\").join("/")] = readFileSync(path).toString("base64");
    }
  };
  walk(dir);
  return files;
}

describe("sync-phone-protocol", () => {
  it("copies the package's sources, the wire vectors and the app host page from HEAD, and names the commit", () => {
    const out = join(scratch(), "protocol");
    execFileSync(process.execPath, [SCRIPT, "--out", out], { cwd: ROOT, stdio: "pipe" });

    const head = git("rev-parse", "HEAD");
    expect(readFileSync(join(out, "SOURCE"), "utf8")).toBe(`${head}\n`);
    const sources = git("ls-tree", "-r", "--name-only", "HEAD", "--", "packages/phone-protocol/src").split("\n")
      .filter((path) => !path.endsWith(".test.ts"));
    for (const name of ["wire", "app-rpc", "cursor-face-data", "failed-turn", "mention-boundary", "upload-limits"]) {
      expect(sources).toContain(`packages/phone-protocol/src/${name}.ts`);
    }
    expect(Object.keys(tree(out)).sort()).toEqual([
      "SOURCE", "app-host.html", "package.json", "vectors/v1.json",
      ...sources.map((path) => path.slice("packages/phone-protocol/".length)),
    ].sort());
    for (const path of sources) expect(readFileSync(join(out, path.slice("packages/phone-protocol/".length)))).toEqual(blob(path));
    expect(readFileSync(join(out, "vectors/v1.json"))).toEqual(blob("companion/src/e2e/vectors/v1.json"));
    expect(readFileSync(join(out, "app-host.html"))).toEqual(blob("shared/app-frame/app-host.html"));
    expect(readFileSync(join(out, "package.json"))).toEqual(blob("packages/phone-protocol/package.json"));
  });

  it("gives the same bytes on every run, and replaces a stale or hand-edited copy", () => {
    const first = join(scratch(), "a");
    const second = join(scratch(), "b");
    syncPhoneProtocol(first);
    syncPhoneProtocol(second);
    const expected = tree(first);
    expect(tree(second)).toEqual(expected);

    writeFileSync(join(second, "src", "wire.ts"), "export type Edited = true;\n");
    writeFileSync(join(second, "src", "removed-upstream.ts"), "export {};\n");
    writeFileSync(join(second, "SOURCE"), "0000000000000000000000000000000000000000\n");
    syncPhoneProtocol(second);
    expect(tree(second)).toEqual(expected);
  });

  it("refuses a directory it did not make and leaves it alone", () => {
    const out = scratch();
    writeFileSync(join(out, "notes.txt"), "mine\n");
    mkdirSync(join(out, "src"));
    writeFileSync(join(out, "src", "keep.ts"), "export {};\n");
    expect(() => syncPhoneProtocol(out)).toThrow(/has no SOURCE/);
    expect(tree(out)).toEqual({ "notes.txt": Buffer.from("mine\n").toString("base64"), "src/keep.ts": Buffer.from("export {};\n").toString("base64") });
  });

  it("refuses a ref that is not a commit, or reads as an option", () => {
    const out = join(scratch(), "protocol");
    expect(() => syncPhoneProtocol(out, "--output=/tmp/x")).toThrow(/not a commit/);
    expect(() => syncPhoneProtocol(out, "no-such-ref-anywhere")).toThrow();
    expect(existsSync(out)).toBe(false);
  });
});
