import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DOCTOR_BACKUPS_DIR } from "../backup.ts";
import { backupFolder, context, dataFolder, manifest, NOW, UUID } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { registryCheck } from "./registry.ts";
import { tempFilesCheck } from "./temp-files.ts";

const run = (data: string, pidAlive = (_pid: number) => false, registry = registryCheck()) =>
  runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, pidAlive, checks: [registry, tempFilesCheck()] });
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

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
    expect(manifest(backup).entries.map((entry) => entry.action)).toEqual(["copied: damaged, then replaced", "the copy put in its place"]);
  });

  it("keeps a copy of an unreadable file it cannot repair, leaves the file, and says what to do", () => {
    const data = dataFolder();
    writeFileSync(join(data, "groups.json"), "");
    writeFileSync(join(data, "bots.json"), "{}");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.fixed).toContain("kept a copy of the damaged groups.json");
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

  it("takes a file it cannot read at all for not checked, never for damaged, and changes nothing", () => {
    const data = dataFolder();
    // A folder in its place: EISDIR everywhere.
    mkdirSync(join(data, "bots.json"));
    writeFileSync(join(data, `bots.json.4242.${UUID}.tmp`), "[]");
    const finding = registryCheck().check(context(data));
    expect(finding).toMatchObject({ status: "problem", summary: expect.stringMatching(/^Could not check bots\.json: E[A-Z]+\.$/) });
    expect(finding.fixable).toBeFalsy();
    expect(finding.keepCopy).toBeFalsy();
    expect(finding.instruction).not.toContain("rollback");
    expect(finding.instruction).not.toContain("put back");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.fixed).toBeUndefined();
    expect(statSync(join(data, "bots.json")).isDirectory()).toBe(true);
    // Its whole copy stays beside it too, for when it can be read again.
    expect(report.checks[1]).toMatchObject({ id: "temp-files", status: "ok" });
    expect(readFileSync(join(data, `bots.json.4242.${UUID}.tmp`), "utf8")).toBe("[]");
    expect(report.backup).toBeNull();
  });

  it.skipIf(process.platform === "win32" || asRoot)("reports a bots.json this user may not read as not checked (EACCES), not damaged", () => {
    const data = dataFolder();
    writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "b1" }]));
    chmodSync(join(data, "bots.json"), 0o000);
    try {
      const finding = registryCheck().check(context(data));
      expect(finding).toMatchObject({ status: "problem", summary: "Could not check bots.json: EACCES." });
      expect(finding.instruction).not.toContain("rollback");
      expect(run(data).backup).toBeNull();
    } finally {
      chmodSync(join(data, "bots.json"), 0o600);
    }
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe(JSON.stringify([{ id: "b1" }]));
  });

  it("leaves bots.json and its whole copy in place when the rename fails halfway, and the temp-file check leaves the copy too", () => {
    const data = dataFolder();
    const temp = join(data, `bots.json.4242.${UUID}.tmp`);
    writeFileSync(join(data, "bots.json"), "[{\"id\":");
    writeFileSync(temp, "[]");
    const failing = registryCheck({ rename: () => { throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" }); } });
    const report = run(data, () => false, failing);
    expect(report.checks[0]).toMatchObject({ id: "registry", status: "failed", summary: expect.stringContaining("The fix failed: cross-device link not permitted") });
    expect(report.checks[1]).toMatchObject({ id: "temp-files", status: "ok" });
    expect(report.counts.fixed).toBe(0);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("[{\"id\":");
    expect(readFileSync(temp, "utf8")).toBe("[]");
    // Both were copied before the rename was tried.
    expect(manifest(backupFolder(data)!).entries.map((entry) => entry.action)).toEqual(["copied: damaged, then replaced", "the copy put in its place"]);
    // The next run repairs it.
    rmBackups(data);
    expect(run(data).checks[0]).toMatchObject({ status: "fixed" });
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("[]");
  });

  it("changes nothing when the backup cannot take its copy", () => {
    const data = dataFolder();
    const temp = join(data, `bots.json.4242.${UUID}.tmp`);
    writeFileSync(join(data, "bots.json"), "[{\"id\":");
    writeFileSync(temp, "[]");
    // A file where the backups folder goes: nothing can be copied there.
    writeFileSync(join(data, DOCTOR_BACKUPS_DIR), "");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ id: "registry", status: "failed" });
    expect(report.checks[1]).toMatchObject({ id: "temp-files", status: "ok" });
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("[{\"id\":");
    expect(readFileSync(temp, "utf8")).toBe("[]");
  });

  it("counts a repair of one file when the other has no copy to put back", () => {
    const data = dataFolder();
    writeFileSync(join(data, "bots.json"), "[{\"id\":");
    writeFileSync(join(data, `bots.json.4242.${UUID}.tmp`), "[]");
    writeFileSync(join(data, "groups.json"), "");
    const report = run(data);
    expect(report.checks[0]).toMatchObject({ status: "problem", repaired: true, summary: expect.stringContaining("groups.json is damaged") });
    expect(report.counts.fixed).toBe(1);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe("[]");
  });
});

function rmBackups(data: string): void {
  rmSync(join(data, DOCTOR_BACKUPS_DIR), { recursive: true, force: true });
}
