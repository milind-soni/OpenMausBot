import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("file overwrite permissions", () => {
  it.each([["022", 0o022], ["077", 0o077]] as const)("preserves existing modes when the process umask is %s", (_label, mask) => {
    const dir = mkdtempSync(join(tmpdir(), "omb-host-file-modes-"));
    made.push(dir);
    const script = `
      import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { hostFileRelay } from ${JSON.stringify(new URL("./host-file-tools.ts", import.meta.url).href)};
      process.umask(Number(process.argv[1]));
      const dir = process.argv[2];
      const relay = hostFileRelay(dir);
      const replaced = [];
      for (const mode of [0o664, 0o775, 0o600]) {
        const path = join(dir, mode.toString(8));
        writeFileSync(path, 'old');
        chmodSync(path, mode);
        const result = await relay({ name: 'write_file', arguments: { path, content: 'new', overwrite: true } });
        replaced.push({ mode: statSync(path).mode & 0o777, content: readFileSync(path, 'utf8'), error: result.isError === true });
      }
      const fresh = join(dir, 'new-file');
      const result = await relay({ name: 'write_file', arguments: { path: fresh, content: 'new' } });
      process.stdout.write(JSON.stringify({ replaced, fresh: statSync(fresh).mode & 0o777, freshError: result.isError === true, files: readdirSync(dir).sort() }));
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, String(mask), dir], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      replaced: [0o664, 0o775, 0o600].map((mode) => ({ mode, content: "new", error: false })),
      fresh: 0o666 & ~mask,
      freshError: false,
      files: ["600", "664", "775", "new-file"],
    });
  });
});
