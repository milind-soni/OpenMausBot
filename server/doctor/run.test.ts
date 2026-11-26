import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { dataFolder, NOW, UUID } from "../testing/doctor-folders.ts";
import { DOCTOR_BACKUPS_DIR, DoctorBackup } from "./backup.ts";
import { tempFilesCheck } from "./checks/temp-files.ts";
import { runDoctor } from "./run.ts";
import type { DoctorCheck } from "./types.ts";

/** A check whose fix runs without error and changes nothing, as a chmod on a filesystem without modes does. */
function stubborn(): DoctorCheck & { looks: number } {
  const check = {
    looks: 0,
    id: "stubborn", title: "Stubborn", looksAt: "nothing",
    check: () => { check.looks += 1; return { status: "problem" as const, fixable: true, summary: "Still wrong." }; },
    fix: () => "Tried.",
  };
  return check;
}

describe("runDoctor", () => {
  it("does not count a fix that changed nothing as a repair", () => {
    const check = stubborn();
    const report = runDoctor({ dataDir: dataFolder(), version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [check] });
    expect(report.checks[0]).toMatchObject({ status: "problem", fixed: "Tried.", repaired: false });
    expect(report.counts.fixed).toBe(0);
    // The first look, the look right before the fix, and the look after it.
    expect(check.looks).toBe(3);
  });

  it("does not count a fix whose look after it failed as a repair", () => {
    let looks = 0;
    const check: DoctorCheck = {
      id: "breaks", title: "Breaks", looksAt: "nothing",
      check: () => {
        looks += 1;
        if (looks === 3) throw new Error("cannot look");
        return { status: "problem", fixable: true, summary: "Wrong." };
      },
      fix: () => "Done.",
    };
    const report = runDoctor({ dataDir: dataFolder(), version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [check] });
    expect(report.checks[0]).toMatchObject({ status: "failed", repaired: false });
    expect(report.counts.fixed).toBe(0);
  });

  it("hands the first look to the looks before and after a fix", () => {
    const earlier: unknown[] = [];
    const check: DoctorCheck = {
      id: "seen", title: "Seen", looksAt: "nothing",
      check: (ctx) => {
        earlier.push(ctx.earlier?.detail);
        return earlier.length === 3 ? { status: "ok", summary: "Fine." } : { status: "problem", fixable: true, summary: "Wrong.", detail: earlier.length };
      },
      fix: () => "Done.",
    };
    const report = runDoctor({ dataDir: dataFolder(), version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [check] });
    expect(earlier).toEqual([undefined, 1, 1]);
    expect(report.checks[0]).toMatchObject({ status: "fixed", repaired: true });
  });

  it.skipIf(process.platform === "win32")("changes nothing on the command when it runs as a user other than the data folder's owner", () => {
    const data = dataFolder();
    const temp = join(data, `config.json.31337.${UUID}.tmp`);
    writeFileSync(temp, "{}");
    const owner = statSync(data).uid;
    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "command", fix: true, now: () => NOW, checks: [tempFilesCheck()], euid: () => owner + 1 });
    expect(report.fix).toMatchObject({ asked: true, ran: false, why: `The data folder belongs to user ${owner}, and this runs as user ${owner + 1}. Run it as the folder's owner. Nothing was changed.` });
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(join(data, DOCTOR_BACKUPS_DIR))).toBe(false);
    // As the owner, it runs.
    expect(runDoctor({ dataDir: data, version: "9.9.9", mode: "command", fix: true, now: () => NOW, checks: [tempFilesCheck()], euid: () => owner }).fix.ran).toBe(true);
    expect(existsSync(temp)).toBe(false);
  });

  it("checks no owner where there is no user id", () => {
    const data = dataFolder();
    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "command", fix: true, now: () => NOW, checks: [stubborn()], euid: () => null });
    expect(report.fix.ran).toBe(true);
  });
});

describe("doctor backups kept", () => {
  const DAY = 86_400_000;
  const runName = (at: number) => new Date(at).toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");

  function oldRun(data: string, at: number, check: string, bytes = 10): string {
    const name = runName(at);
    const folder = join(data, DOCTOR_BACKUPS_DIR, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "copy"), Buffer.alloc(bytes));
    writeFileSync(join(folder, "manifest.json"), JSON.stringify({ entries: [{ check, action: "copied before the fix", path: "x" }] }));
    return name;
  }

  it("keeps a run with a registry copy for 30 days beyond the newest runs, and not after", () => {
    const data = dataFolder();
    const recentRegistry = oldRun(data, NOW - 20 * DAY, "registry");
    const staleRegistry = oldRun(data, NOW - 40 * DAY, "registry");
    const oldTemps = oldRun(data, NOW - 19 * DAY, "temp-files");
    const newer = [1, 2].map((days) => oldRun(data, NOW - days * DAY, "temp-files"));
    new DoctorBackup(data, () => NOW, { kept: 3 }).note("test", "a note", data);
    const left = readdirSync(join(data, DOCTOR_BACKUPS_DIR));
    expect(left).toContain(recentRegistry);
    expect(left).not.toContain(staleRegistry);
    expect(left).not.toContain(oldTemps);
    for (const name of newer) expect(left).toContain(name);
    expect(left).toHaveLength(4);
  });

  it("keeps the older runs under the size cap, oldest first, but never a registry copy under 30 days", () => {
    const data = dataFolder();
    const big = [5, 4, 3].map((days) => oldRun(data, NOW - days * DAY, "messages-db", 1000));
    const registry = oldRun(data, NOW - 6 * DAY, "registry", 1000);
    new DoctorBackup(data, () => NOW, { kept: 10, maxBytes: 2500 }).note("test", "a note", data);
    const left = readdirSync(join(data, DOCTOR_BACKUPS_DIR));
    expect(left).toContain(registry);
    expect(left).not.toContain(big[0]);
    expect(left).not.toContain(big[1]);
    expect(left).toContain(big[2]);
  });
});
