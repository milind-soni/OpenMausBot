import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, NOW } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { engineRunsCheck } from "./engine-runs.ts";

const tag = (n: number) => n.toString(16).padStart(32, "0");

describe("engine-runs check", () => {
  it("moves records with neither a server nor a process into the backup, and leaves every other", () => {
    const data = dataFolder();
    const runs = join(data, "engine-runs");
    const orphan = join(runs, tag(1)), withServer = join(runs, tag(2)), clean = join(runs, tag(3));
    for (const dir of [orphan, withServer, clean]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(orphan, "server.json"), "");
    writeFileSync(join(withServer, "server.json"), JSON.stringify({ pid: 12, start: "x" }));
    writeFileSync(join(clean, "clean"), "");
    mkdirSync(join(runs, "not-a-run"));
    expect(engineRunsCheck().check(context(data))).toMatchObject({ status: "problem", fixable: true });

    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [engineRunsCheck()] });
    expect(report.checks[0]).toMatchObject({ status: "fixed", fixed: "Moved 1 into the backup." });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(backupFolder(data)!, "engine-runs", tag(1), "server.json"))).toBe(true);
    for (const dir of [withServer, clean, join(runs, "not-a-run")]) expect(existsSync(dir)).toBe(true);
  });

  it("leaves a record that names processes but not its server for a person", () => {
    const data = dataFolder();
    const unknown = join(data, "engine-runs", tag(4));
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, "777.json"), JSON.stringify({ pid: 777, start: "y" }));
    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [engineRunsCheck()] });
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.instruction).toContain("may still be running");
    expect(existsSync(join(unknown, "777.json"))).toBe(true);
  });

  it("is fine without the folder", () => {
    expect(engineRunsCheck().check(context(dataFolder())).status).toBe("ok");
  });
});
