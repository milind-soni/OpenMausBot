import { chmodSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, manifest, NOW } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { secretModesCheck } from "./secret-modes.ts";

describe.skipIf(process.platform === "win32")("secret-modes check", () => {
  it("makes private files others can read owner-only, writing down the old mode and copying nothing", () => {
    const data = dataFolder();
    for (const name of ["config.json", "sessions.json", "notes.txt"]) writeFileSync(join(data, name), "{\"key\":\"secret\"}");
    chmodSync(join(data, "config.json"), 0o644);
    chmodSync(join(data, "sessions.json"), 0o600);
    chmodSync(join(data, "notes.txt"), 0o644);
    expect(secretModesCheck().check(context(data))).toMatchObject({ status: "problem", fixable: true, summary: "Others can read config.json (0644)." });

    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [secretModesCheck()] });
    expect(report.checks[0]).toMatchObject({ status: "fixed" });
    expect(statSync(join(data, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, "notes.txt")).mode & 0o777).toBe(0o644);
    const backup = backupFolder(data)!;
    expect(readdirSync(backup)).toEqual(["manifest.json"]);
    expect(manifest(backup).entries).toEqual([{ check: "secret-modes", action: "made owner-only (0600); the old mode is here", path: join(data, "config.json"), mode: "0644" }]);
  });
});

describe("secret-modes check on Windows", () => {
  it("does not look", () => {
    expect(secretModesCheck("win32").check(context(dataFolder())).summary).toBe("Not checked on Windows.");
  });
});
