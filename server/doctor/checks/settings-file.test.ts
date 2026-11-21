import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { context, dataFolder } from "../../testing/doctor-folders.ts";
import { settingsFileCheck } from "./settings-file.ts";

describe("settings-file check", () => {
  it("finds a readable or missing config.json fine", () => {
    const data = dataFolder();
    expect(settingsFileCheck().check(context(data)).status).toBe("ok");
    writeFileSync(join(data, "config.json"), "﻿{\"instances\":{}}");
    expect(settingsFileCheck().check(context(data)).status).toBe("ok");
  });

  it("points at the dated copies for one it cannot understand, never quoting it, never fixing it", () => {
    const data = dataFolder();
    writeFileSync(join(data, "config.json"), "{\"anthropic\":{\"key\":\"sk-ant-secret\"");
    writeFileSync(join(data, "config.json.bak.20261116-101010"), "{}");
    const finding = settingsFileCheck().check(context(data));
    expect(finding).toMatchObject({ status: "problem" });
    expect(finding.fixable).toBeFalsy();
    expect(finding.instruction).toContain("openmausbot config restore latest");
    expect(JSON.stringify(finding)).not.toContain("sk-ant-secret");
  });

  it("without dated copies, points at the copy from before the update", () => {
    const data = dataFolder();
    writeFileSync(join(data, "config.json"), "[]");
    expect(settingsFileCheck().check(context(data)).instruction).toContain("./update.sh --rollback");
  });
});
