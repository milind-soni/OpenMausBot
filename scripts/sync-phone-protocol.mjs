#!/usr/bin/env node
// Copies the phone protocol into another checkout, as one commit of this repository holds it:
//
//   node scripts/sync-phone-protocol.mjs --out <dir> [--ref <commit>]
//
// Files are read from git, never the working tree, so the copy is exactly what SOURCE names and the same commit always
// gives the same bytes: the phone repository's CI re-runs this at SOURCE and fails on any difference.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "packages/phone-protocol";

/** Where each copied file comes from, by its path under the output directory. */
export function syncedFiles(ref, root = ROOT) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new Error(`not a commit: ${ref}`);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const source = git("ls-tree", "-r", "--name-only", "-z", commit, "--", `${PACKAGE}/src`).split("\0")
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
  const files = new Map([
    ["package.json", `${PACKAGE}/package.json`],
    ...source.map((path) => [path.slice(PACKAGE.length + 1), path]),
    ["vectors/v1.json", "companion/src/e2e/vectors/v1.json"],
    ["app-host.html", "shared/app-frame/app-host.html"],
  ]);
  return { commit, files };
}

/** The top-level names this script owns in the output directory: only these are replaced. */
const OWNED = ["SOURCE", "package.json", "src", "vectors", "app-host.html"];

export function syncPhoneProtocol(out, ref = "HEAD", root = ROOT) {
  const { commit, files } = syncedFiles(ref, root);
  const target = resolve(out);
  if (existsSync(target) && readdirSync(target).length > 0 && !existsSync(join(target, "SOURCE"))) {
    throw new Error(`${target} is not empty and has no SOURCE: refusing to write into a directory this script did not make`);
  }
  for (const name of OWNED) rmSync(join(target, name), { recursive: true, force: true });
  for (const [path, from] of files) {
    const bytes = execFileSync("git", ["cat-file", "blob", `${commit}:${from}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes);
  }
  writeFileSync(join(target, "SOURCE"), `${commit}\n`);
  return { commit, count: files.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = (name) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const out = flag("--out");
  if (!out) {
    console.error("Usage: node scripts/sync-phone-protocol.mjs --out <dir> [--ref <commit>]");
    process.exit(2);
  }
  try {
    const { commit, count } = syncPhoneProtocol(out, flag("--ref") ?? "HEAD");
    console.log(`copied ${count} files from ${commit} to ${resolve(out)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
