import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each(["manual", "scheduled"])("contains a %s check's rejection after its result was saved", (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-check-failure-"));
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "server/testing/routine-check-failures.ts", dir, mode], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, OMB_DATA_DIR: dir },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("fixture survived");
    expect(child.stderr).toContain(mode === "manual" ? "fixture disk full" : "fixture receipt notification failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
