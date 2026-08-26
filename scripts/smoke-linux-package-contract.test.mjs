import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Linux package smoke network isolation", () => {
  it("treats every optional broker request as a failure", () => {
    const electronMain = fs.readFileSync(path.join(root, "electron", "main.mjs"), "utf8");
    const packageSmoke = fs.readFileSync(path.join(root, "scripts", "smoke-linux-package.mjs"), "utf8");

    expect(electronMain).toContain("if (!SMOKE_TEST) void hostedAccount.restore()");
    expect(electronMain).toContain("if (!SMOKE_TEST && app.isPackaged && composioBrokerUrl()");
    expect(packageSmoke).toContain("if (brokerRequests !== 0)");
    expect(packageSmoke).not.toContain("brokerRequests > 0");
  });

  it("enters the isolated CUA initializer for the Wayland safety lane", () => {
    const electronMain = fs.readFileSync(path.join(root, "electron", "main.mjs"), "utf8");
    const packageSmoke = fs.readFileSync(path.join(root, "scripts", "smoke-linux-package.mjs"), "utf8");

    expect(packageSmoke).toContain('OMB_SMOKE_CUA: hardDeath || bundled ? "0" : "1"');
    expect(packageSmoke).not.toContain(
      'OMB_SMOKE_CUA: hardDeath || bundled || sessionBlocked ? "0" : "1"',
    );
    expect(electronMain).toContain(
      'SMOKE_CUA && process.env.OMB_SMOKE_LINUX_CUA_BLOCKED !== "1"',
    );
    expect(electronMain).toContain("JSON.stringify(SMOKE_CUA_CRASH_RETRY)");
  });
});
