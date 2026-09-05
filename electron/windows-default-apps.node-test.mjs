import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { grokBotDefaultAppsSettingsUrl } from "./windows-default-apps.mjs";

describe("Windows Grok Bot default-app handoff", () => {
  it("opens only the Windows-owned app-specific settings page", () => {
    assert.equal(
      grokBotDefaultAppsSettingsUrl("win32"),
      "ms-settings:defaultapps?registeredAppUser=OpenMausBot",
    );
    assert.equal(grokBotDefaultAppsSettingsUrl("darwin"), null);
    assert.equal(grokBotDefaultAppsSettingsUrl("linux"), null);
  });

  it("registers a candidate ProgID and removes only OpenMausBot-owned keys", () => {
    const installer = readFileSync(join(process.cwd(), "build", "installer.nsh"), "utf8");
    assert.match(installer, /Software\\Classes\\OpenMausBot\.GrokBot/);
    assert.match(installer, /Software\\OpenMausBot\\Capabilities/);
    assert.match(installer, /Software\\RegisteredApplications/);
    assert.match(installer, /Capabilities\\UrlAssociations" "grokbot" "OpenMausBot\.GrokBot"/);
    assert.doesNotMatch(installer, /UserChoice/);
    assert.doesNotMatch(installer, /grokbot\\shell\\open\\command/);
  });
});
