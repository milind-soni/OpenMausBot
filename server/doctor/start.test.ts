import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { dataFolder, NOW, UUID } from "../testing/doctor-folders.ts";
import { dataDoctorOutcome } from "./command.ts";
import { runDoctor } from "./run.ts";
import { DOCTOR_STATE_FILE, doctorAtStart, doctorSummary } from "./start.ts";
import type { DoctorCheck } from "./types.ts";

const stray = (data: string) => {
  // A server's folder as ensureDirs() leaves it, so the only finding is the temp file.
  for (const name of ["events", "native"]) mkdirSync(join(data, name), { recursive: true });
  const name = `config.json.31337.${UUID}.tmp`;
  writeFileSync(join(data, name), "{}");
  return join(data, name);
};

describe("the doctor at start", () => {
  it("runs on the first start of a version, fixes, logs a line each, records the version, and keeps a summary", () => {
    const data = dataFolder();
    const temp = stray(data);
    const lines: string[] = [];
    const summary = doctorAtStart(data, "1.2.3", { now: () => NOW, pidAlive: () => false, log: (line) => lines.push(line) });
    expect(existsSync(temp)).toBe(false);
    expect(summary).toMatchObject({ version: "1.2.3", fixed: ["temp-files"], problems: [], thisStart: true });
    expect(doctorSummary()).toEqual(summary);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[doctor\] temp-files: 1 temp file .* Fixed: Moved 1 into the backup\.$/);
    expect(lines.at(-1)).toMatch(/^\[doctor\] first start of 1\.2\.3: 9 checks, 1 fixed, 0 need a person; what was changed was copied to .*doctor-backups/);
    expect(JSON.parse(readFileSync(join(data, DOCTOR_STATE_FILE), "utf8"))).toMatchObject({ version: "1.2.3" });
    // The summary names checks and counts, never a path.
    expect(JSON.stringify(summary)).not.toContain(data);
  });

  it("does not run again for the same version, and runs for the next one", () => {
    const data = dataFolder();
    doctorAtStart(data, "1.2.3", { now: () => NOW, pidAlive: () => false, log: () => {} });
    const temp = stray(data);
    const lines: string[] = [];
    expect(doctorAtStart(data, "1.2.3", { now: () => NOW, pidAlive: () => false, log: (line) => lines.push(line) })).toMatchObject({ thisStart: false, version: "1.2.3" });
    expect(lines).toEqual([]);
    expect(existsSync(temp)).toBe(true);
    doctorAtStart(data, "1.2.4", { now: () => NOW, pidAlive: () => false, log: (line) => lines.push(line) });
    expect(existsSync(temp)).toBe(false);
    expect(lines.at(-1)).toContain("first start of 1.2.4 (last: 1.2.3)");
  });

  it("never throws: a check that fails is a finding, and the server goes on", () => {
    const data = dataFolder();
    const broken: DoctorCheck = { id: "broken", title: "Broken", looksAt: "nothing", check() { throw new Error("boom"); } };
    const lines: string[] = [];
    const summary = doctorAtStart(data, "1.0.0", { checks: [broken], now: () => NOW, log: (line) => lines.push(line) });
    expect(summary).toMatchObject({ problems: ["broken"] });
    expect(lines[0]).toBe("[doctor] broken: The check itself failed: boom");
  });
});

describe("doctor-backups", () => {
  it("keeps the newest ten runs' copies", () => {
    const data = dataFolder();
    for (let n = 0; n < 12; n += 1) {
      stray(data);
      runDoctor({ dataDir: data, version: "1.0.0", mode: "start", fix: true, now: () => NOW + n * 1000, pidAlive: () => false });
    }
    const runs = readdirSync(join(data, "doctor-backups")).sort();
    expect(runs).toHaveLength(10);
    expect(runs[0]).toBe("2026-11-17T09-30-02Z");
  });
});

describe("openmausbot doctor --data", () => {
  it("reports without changing anything, and says --fix repairs it; exit 8 while a problem is left", () => {
    const data = dataFolder();
    const temp = stray(data);
    const outcome = dataDoctorOutcome(runDoctor({ dataDir: data, version: "1.0.0", mode: "command", fix: false, now: () => NOW, pidAlive: () => false }));
    expect(outcome.exitCode).toBe(8);
    expect(existsSync(temp)).toBe(true);
    expect(outcome.human).toContain("        openmausbot doctor --data --fix repairs it");
    expect(outcome.result).toMatchObject({ ok: false, counts: { problems: expect.any(Number), fixed: 0 } });
  });

  it("with --fix takes the lease for its run, repairs, and exits 0 when all is fine", () => {
    const data = dataFolder();
    const temp = stray(data);
    const report = runDoctor({ dataDir: data, version: "1.0.0", mode: "command", fix: true, now: () => NOW, pidAlive: () => false });
    const outcome = dataDoctorOutcome(report);
    expect(report.checks.filter((result) => result.status !== "ok" && result.status !== "fixed")).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.human.at(-1)).toMatch(/^All fine now: \d+ fixed\.$/);
    expect(existsSync(temp)).toBe(false);
    // The lease was let go.
    expect(existsSync(join(data, "openmausbot-server.lease"))).toBe(false);
  });
});
