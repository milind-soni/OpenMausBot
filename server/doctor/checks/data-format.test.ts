import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { context, dataFolder, NOW, UUID } from "../../testing/doctor-folders.ts";
import { DOCTOR_BACKUPS_DIR } from "../backup.ts";
import { runDoctor } from "../run.ts";
import { dataFormatCheck } from "./data-format.ts";
import { tempFilesCheck } from "./temp-files.ts";

describe("data-format check", () => {
  it("takes a folder without a marker, or with one this version reads, as fine", () => {
    const data = dataFolder();
    expect(dataFormatCheck().check(context(data)).status).toBe("ok");
    writeFileSync(join(data, "data-format.json"), JSON.stringify({ format: 1, writtenBy: "0.1.160", writtenAt: "" }));
    expect(dataFormatCheck().check(context(data)).status).toBe("ok");
  });

  it("refuses a newer format, never fixes it, and then lets no other fix run", () => {
    const data = dataFolder();
    writeFileSync(join(data, "data-format.json"), JSON.stringify({ format: 2, writtenBy: "0.2.0", writtenAt: "" }));
    const finding = dataFormatCheck().check(context(data));
    expect(finding).toMatchObject({ status: "problem", blocking: true });
    expect(finding.fixable).toBeFalsy();
    expect(finding.instruction).toContain("0.2.0");

    const stray = join(data, `bots.json.999999.${UUID}.tmp`);
    writeFileSync(stray, "[]");
    const report = runDoctor({ dataDir: data, version: "0.1.170", mode: "command", fix: true, now: () => NOW, pidAlive: () => false,
      checks: [dataFormatCheck(), tempFilesCheck()], acquireLease: () => ({ release() {} }) });
    expect(report.fix).toMatchObject({ asked: true, ran: false });
    expect(report.fix.why).toContain("newer OpenMausBot");
    expect(report.checks.map((result) => result.status)).toEqual(["problem", "problem"]);
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(join(data, DOCTOR_BACKUPS_DIR))).toBe(false);
  });
});
