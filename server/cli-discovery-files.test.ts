import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { findCliCandidates } from "./env-path.ts";

const dirs: string[] = [];
const name = "omb-discovery-fixture";
const filename = `${name}${process.platform === "win32" ? ".EXE" : ""}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-cli-discovery-")); dirs.push(root);
  const first = join(root, "first"), second = join(root, "second");
  mkdirSync(first); mkdirSync(second);
  vi.stubEnv("PATHEXT", ".EXE");
  return { first, second, path: [first, second].join(delimiter) };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("does not offer a same-named directory ahead of the actual CLI file", () => {
  const { first, second, path } = fixture();
  mkdirSync(join(first, filename));
  const cli = join(second, filename);
  writeFileSync(cli, "fixture", { mode: 0o755 });
  expect(findCliCandidates(name, path)).toEqual([cli]);
});

it.skipIf(process.platform === "win32")("the first discovered copy can launch past a directory on PATH", () => {
  const { first, second, path } = fixture();
  mkdirSync(join(first, filename));
  writeFileSync(join(second, filename), `#!${process.execPath}\nprocess.stdout.write('fixture ready');\n`, { mode: 0o755 });
  const result = spawnSync(findCliCandidates(name, path)[0]!, [], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("fixture ready");
});

it.skipIf(process.platform === "win32")("ignores links to directories while retaining links to executable files", () => {
  const { first, second, path } = fixture();
  const directory = join(first, "target-directory"); mkdirSync(directory);
  symlinkSync(directory, join(first, filename));
  const target = join(second, "target-file"); writeFileSync(target, "fixture", { mode: 0o755 });
  const cli = join(second, filename); symlinkSync(target, cli);
  expect(findCliCandidates(name, path)).toEqual([cli]);
});

it("keeps regular CLI copies in PATH order and ignores absent entries", () => {
  const { first, second, path } = fixture();
  const copies = [first, second].map((dir) => join(dir, filename));
  for (const copy of copies) writeFileSync(copy, "fixture", { mode: 0o755 });
  expect(findCliCandidates(name, [join(first, "absent"), path].join(delimiter))).toEqual(copies);
});
