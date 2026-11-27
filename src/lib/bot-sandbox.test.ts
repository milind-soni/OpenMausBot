import { beforeEach, describe, expect, it } from "vitest";

import { botSandboxLines, sandboxInstallCommand } from "./bot-sandbox";
import { setLocale } from "./i18n";

describe("the bots' sandbox row", () => {
  beforeEach(() => setLocale("en"));

  it("says on, with what it does not separate, the self-check once it ran, and a failed must-pass check as a danger", () => {
    expect(botSandboxLines({ state: "on", reason: null, required: true, checks: null }, "maus.example.com")).toEqual({
      value: "On", tone: "ok",
      detail: "Each bot's engine and commands run in a sandbox, away from this server's settings, keys and database, and from other bots' work folders. Bots still share one home folder for their AI engines, so a bot can read what other bots' engines keep there (their conversation history and settings), and the bots' web browser runs outside the sandbox.",
    });
    expect(botSandboxLines({ state: "on", reason: null, required: true, checks: { passed: 31, total: 31, failed: [] } }, "maus.example.com").detail).toMatch(/Self-check: 31 of 31 passed\.$/);
    const failed = botSandboxLines({ state: "on", reason: null, required: false, checks: { passed: 30, total: 31, failed: ["config-hidden"] } }, "maus.example.com");
    expect(failed.tone).toBe("danger");
    expect(failed.detail).toMatch(/^Its self-check failed: config-hidden\. Bots may not be safely separated from the server\./);
  });

  it("shows a check that only warns quietly, never as a danger", () => {
    const warned = botSandboxLines({ state: "on", reason: null, required: true, checks: { passed: 31, total: 32, failed: ["nested-userns-blocked"] } }, "maus.example.com");
    expect(warned.tone).toBe("ok");
    expect(warned.detail).toMatch(/Self-check: 31 of 32 passed\. Its self-check warned about: nested-userns-blocked\. Bots are still kept from the server's settings and keys\.$/);
  });

  it("says off with why, and the command that turns it on where running the installer again does", () => {
    const old = botSandboxLines({ state: "off", reason: "userns-refused", required: false, checks: null }, "maus.example.com");
    expect(old).toEqual({
      value: "Off", tone: "danger",
      detail: "Bots run beside the server, as its own user, able to read its settings and keys. This server's host isn't prepared for it.",
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
    expect(refusing.detail).toBe("This server requires the sandbox and it is not running safely, so bots' commands are refused until it is. This server's host isn't prepared for it.");
    expect(refusing.command).toBe(sandboxInstallCommand("maus.example.com"));
    expect(sandboxInstallCommand("")).toContain("--domain maus.example.com");
  });

  it("names the must-pass checks that failed when the self-check refuses bots, and a start that failed", () => {
    const checked = botSandboxLines({ state: "refusing", reason: "self-check-failed", required: true, checks: { passed: 30, total: 32, failed: ["config-hidden", "nested-userns-blocked"], warned: ["nested-userns-blocked"] } }, "maus.example.com");
    expect(checked.tone).toBe("danger");
    expect(checked.detail).toMatch(/refused until it is\. Its self-check failed: config-hidden\. Restart the server once that is fixed\./);
    expect(checked.command).toBeUndefined();
    expect(botSandboxLines({ state: "refusing", reason: "self-check-failed", required: true, checks: { passed: 0, total: 0, failed: [] } }, "m.example.com").detail).toMatch(/failed: no-answer\./);
    expect(botSandboxLines({ state: "refusing", reason: "start-failed", required: true, checks: null }, "m.example.com").detail).toMatch(/It could not start when the server started; the server's log says why\./);
  });
});
