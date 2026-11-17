import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, manifest, NOW, UUID } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { tempFilesCheck } from "./temp-files.ts";

describe("temp-files check", () => {
  it("moves the temp files of saves whose process is gone into the backup, and nothing else", () => {
    const data = dataFolder();
    const dead = `config.json.31337.${UUID}.tmp`, live = `routines.json.4242.${UUID}.tmp`, own = `sessions.json.${process.pid}.${UUID}.tmp`;
    for (const name of [dead, live, own, "notes.123.tmp", "bots.json"]) writeFileSync(join(data, name), name);
    mkdirSync(join(data, "bots"));
    writeFileSync(join(data, "bots", `work.31337.${UUID}.tmp`), "a person's file");
    const pidAlive = (pid: number) => pid === 4242;
    expect(tempFilesCheck().check(context(data, { pidAlive }))).toMatchObject({ status: "problem", fixable: true, summary: "1 temp file left by save that did not finish (config.json)." });

    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, pidAlive, checks: [tempFilesCheck()] });
    expect(report.checks[0]).toMatchObject({ status: "fixed", fixed: "Moved 1 into the backup." });
    expect(existsSync(join(data, dead))).toBe(false);
    expect(readFileSync(join(backupFolder(data)!, dead), "utf8")).toBe(dead);
    expect(manifest(backupFolder(data)!).entries).toHaveLength(1);
    for (const name of [live, own, "notes.123.tmp", "bots.json"]) expect(existsSync(join(data, name))).toBe(true);
    expect(existsSync(join(data, "bots", `work.31337.${UUID}.tmp`))).toBe(true);
  });

  it("is fine with none", () => {
    expect(tempFilesCheck().check(context(dataFolder())).status).toBe("ok");
  });
});
