import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, manifest, NOW } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { foldersCheck } from "./folders.ts";

const run = (data: string) => runDoctor({ dataDir: data, version: "9.9.9", mode: "command", fix: true, now: () => NOW, checks: [foldersCheck()], acquireLease: () => ({ release() {} }) });

describe("folders check", () => {
  it("makes the server's missing folders and writes down that it did", () => {
    const data = dataFolder();
    mkdirSync(join(data, "events"));
    expect(foldersCheck().check(context(data))).toMatchObject({ status: "problem", fixable: true, summary: "Missing folder: native." });
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "fixed", fixed: "Made native." });
    expect(statSync(join(data, "native")).isDirectory()).toBe(true);
    expect(manifest(backupFolder(data)!).entries).toEqual([{ check: "folders", action: "folder made", path: join(data, "native") }]);
  });

  it("does not make a data folder that is not there, nor anything in it", () => {
    const data = join(dataFolder(), "not-here");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.fix.ran).toBe(false);
    expect(existsSync(data)).toBe(false);
  });

  it("leaves a file where a folder should be for a person", () => {
    const data = dataFolder();
    mkdirSync(join(data, "events"));
    writeFileSync(join(data, "native"), "");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.instruction).toContain(join(data, "native"));
    expect(statSync(join(data, "native")).isFile()).toBe(true);
  });
});
