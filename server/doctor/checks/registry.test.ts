import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, manifest, NOW, UUID } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { registryCheck } from "./registry.ts";
import { tempFilesCheck } from "./temp-files.ts";

const run = (data: string, pidAlive = (_pid: number) => false) =>
  runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, pidAlive, checks: [registryCheck(), tempFilesCheck()] });

describe("registry check", () => {
  it("finds readable or missing registries fine", () => {
    const data = dataFolder();
    expect(registryCheck().check(context(data)).status).toBe("ok");
    writeFileSync(join(data, "bots.json"), "[]");
    expect(registryCheck().check(context(data)).status).toBe("ok");
  });

  it("puts back an unreadable bots.json from the whole copy an interrupted save left, keeping the damaged one", () => {
    const data = dataFolder();
    const whole = JSON.stringify([{ id: "b1", name: "Ada" }]);
    writeFileSync(join(data, "bots.json"), "[{\"id\":\"b1\",\"na");
    writeFileSync(join(data, `bots.json.4242.${UUID}.tmp`), whole);
    expect(registryCheck().check(context(data))).toMatchObject({ status: "problem", fixable: true });

    const report = run(data);
    expect(report.checks[0]).toMatchObject({ id: "registry", status: "fixed" });
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe(whole);
    if (process.platform !== "win32") expect(statSync(join(data, "bots.json")).mode & 0o777).toBe(0o600);
    // The temp file became bots.json: nothing is left for the temp-file check.
    expect(report.checks[1]).toMatchObject({ id: "temp-files", status: "ok" });
    const backup = backupFolder(data)!;
    expect(readFileSync(join(backup, "bots.json"), "utf8")).toBe("[{\"id\":\"b1\",\"na");
    expect(manifest(backup).entries.map((entry) => entry.action)).toEqual(["moved aside: could not be read", "the copy put in its place"]);
  });

  it("keeps a copy of an unreadable file it cannot repair, leaves the file, and says what to do", () => {
    const data = dataFolder();
    writeFileSync(join(data, "groups.json"), "");
    writeFileSync(join(data, "bots.json"), "{}");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.fixed).toContain("kept a copy of the unreadable groups.json");
    expect(report.checks[0]!.repaired).toBe(false);
    expect(report.counts.fixed).toBe(0);
    expect(report.checks[0]!.instruction).toContain("./update.sh --rollback");
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(backupFolder(data)!, "bots.json"), "utf8")).toBe("{}");
    expect(existsSync(join(backupFolder(data)!, "groups.json"))).toBe(true);
  });

  it("never takes a save from before the damaged file was written", () => {
    const data = dataFolder();
    writeFileSync(join(data, "bots.json"), "[{\"id\":");
    const older = join(data, `bots.json.4242.${UUID}.tmp`);
    writeFileSync(older, "[]");
    utimesSync(older, new Date(NOW - 86_400_000), new Date(NOW - 86_400_000));
    utimesSync(join(data, "bots.json"), new Date(NOW), new Date(NOW));
    expect(registryCheck().check(context(data))).toMatchObject({ status: "problem", fixable: false, keepCopy: true });
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", repaired: false });
    // The older save is not lost either: it goes into the backup with the other unfinished saves.
    expect(report.checks[1]).toMatchObject({ id: "temp-files", status: "fixed" });
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("[{\"id\":");
  });

  it("never takes the temp file of a save still running", () => {
    const data = dataFolder();
    writeFileSync(join(data, "bots.json"), "nope");
    writeFileSync(join(data, `bots.json.4242.${UUID}.tmp`), "[]");
    const report = run(data, (pid) => pid === 4242);
    expect(report.checks[0]!.fixable).toBe(false);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("nope");
    expect(existsSync(join(data, `bots.json.4242.${UUID}.tmp`))).toBe(true);
  });
});
