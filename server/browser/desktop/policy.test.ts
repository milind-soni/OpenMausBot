import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { desktopPolicy, policyWrap } from "./policy.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("the lock-down policy of a Chrome on a private display", () => {
  it("blocks files, Chrome's pages, DevTools and page source, but keeps the new tab page and the DevTools Protocol", () => {
    const policy = desktopPolicy();
    expect(policy.URLBlocklist).toEqual(["file://*", "chrome://*", "devtools://*", "view-source:*"]);
    expect(policy.URLAllowlist).toEqual(["chrome://newtab", "chrome://new-tab-page", "chrome://new-tab-page-third-party"]);
    expect(policy.IncognitoModeAvailability).toBe(1);
    expect(policy.AllowFileSelectionDialogs).toBe(false);
    expect(policy).not.toHaveProperty("DeveloperToolsAvailability");
    expect(policy.PrivacySandboxPromptEnabled).toBe(false);
    expect(policy.PromotionsEnabled).toBe(false);
  });

  it("lets through only the folders named, and nothing beside them", () => {
    expect(desktopPolicy(["/data/.openmausbot/workspaces/scout/", "/srv/files"]).URLAllowlist).toEqual(expect.arrayContaining(["file:///data/.openmausbot/workspaces/scout/", "file:///srv/files/"]));
  });

  it("is put in force for that Chrome alone, in every installed brand's folder of a private mount namespace", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "omb-policy-")), "policy");
    folders.push(join(dir, ".."));
    const installed = new Set(["/etc/chromium"]);
    const wrap = policyWrap("/usr/bin/bwrap", dir, [], (path) => installed.has(path));
    expect(wrap.command).toBe("/usr/bin/bwrap");
    expect(wrap.args).toEqual([
      "--dev-bind", "/", "/", "--die-with-parent",
      "--tmpfs", "/etc/opt", "--ro-bind", dir, "/etc/opt/chrome/policies/managed",
      "--ro-bind", dir, "/etc/opt/chrome_for_testing/policies/managed",
      "--tmpfs", "/etc/chromium/policies", "--ro-bind", dir, "/etc/chromium/policies/managed",
      "--",
    ]);
    expect(JSON.parse(readFileSync(join(dir, "openmausbot.json"), "utf8"))).toEqual(desktopPolicy());
    if (process.platform !== "win32") expect(statSync(join(dir, "openmausbot.json")).mode & 0o777).toBe(0o600);
    expect(policyWrap("/usr/bin/bwrap", dir, [], () => false).args).not.toContain("/etc/chromium/policies/managed");
  });
});
