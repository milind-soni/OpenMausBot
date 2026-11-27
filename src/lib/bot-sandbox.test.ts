import { beforeEach, describe, expect, it } from "vitest";

import { botSandboxLines, sandboxInstallCommand } from "./bot-sandbox";
import { setLocale } from "./i18n";

describe("the bots' sandbox row", () => {
  beforeEach(() => setLocale("en"));

  it("says on, with the self-check once it ran, and names a failed check as a danger", () => {
    expect(botSandboxLines({ state: "on", reason: null, required: true, checks: null }, "maus.example.com")).toEqual({
      value: "On", tone: "ok", detail: "Each bot's engine and commands run in a sandbox, away from this server's settings, keys and other bots' files.",
    });
    expect(botSandboxLines({ state: "on", reason: null, required: true, checks: { passed: 31, total: 31, failed: [] } }, "maus.example.com").detail).toMatch(/Self-check: 31 of 31 passed\.$/);
    const failed = botSandboxLines({ state: "on", reason: null, required: true, checks: { passed: 30, total: 31, failed: ["config-hidden"] } }, "maus.example.com");
    expect(failed.tone).toBe("danger");
    expect(failed.detail).toMatch(/^Its self-check failed: config-hidden\. Bots may not be safely separated from the server\./);
  });

  it("says off with why, and the command that turns it on where running the installer again does", () => {
    const old = botSandboxLines({ state: "off", reason: "userns-refused", required: false, checks: null }, "maus.example.com");
    expect(old).toEqual({
      value: "Off", tone: "danger",
      detail: "Bots run beside the server, as its own user, able to read its settings, keys and each other's files. This server's host isn't prepared for it.",
      command: "curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain maus.example.com",
    });
    const asked = botSandboxLines({ state: "off", reason: "switched-off", required: false, checks: null }, "maus.example.com");
    expect(asked.tone).toBe("quiet");
    expect(asked.detail).toMatch(/It was switched off on this server \(the installer's --no-sandbox, or OMB_BOT_BOX=0\)\.$/);
    expect(asked.command).toBe(sandboxInstallCommand("maus.example.com"));
    expect(botSandboxLines({ state: "off", reason: "no-bwrap", required: false, checks: null }, "x.example.com").command).toBeUndefined();
  });

  it("says required and not running, with why, as a danger", () => {
    const refusing = botSandboxLines({ state: "refusing", reason: "userns-refused", required: true, checks: null }, "maus.example.com");
    expect(refusing.value).toBe("Required, not running");
    expect(refusing.tone).toBe("danger");
    expect(refusing.detail).toBe("This server requires the sandbox and it could not start, so bots' commands are refused until it can. This server's host isn't prepared for it.");
    expect(refusing.command).toBe(sandboxInstallCommand("maus.example.com"));
    expect(sandboxInstallCommand("")).toContain("--domain maus.example.com");
  });
});
