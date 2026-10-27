import { describe, expect, it } from "vitest";

import {
  connectedAppsForSetup,
  expandSetupTurnText,
  parseSetupCommand,
  setupModeActive,
  setupSystemPrompt,
  type SetupConnectedApps,
} from "./setup-mode.ts";

const AVAILABLE: SetupConnectedApps = { state: "available" };
const EVERY_STATE: Array<[string, SetupConnectedApps]> = [
  ["available", AVAILABLE],
  ["switched off", { state: "off", noTools: false }],
  ["no tools", { state: "off", noTools: true }],
  ["server without a key", { state: "not-configured", host: "server" }],
  ["desktop service down", { state: "not-configured", host: "desktop" }],
  ["Cloud service down", { state: "not-configured", host: "cloud" }],
  ["model cannot", { state: "unsupported" }],
];

describe("parseSetupCommand", () => {
  it("recognises /setup with and without a request", () => {
    expect(parseSetupCommand("/setup")).toEqual({ request: "" });
    expect(parseSetupCommand("  /SETUP watch Discord and file bugs into Linear  ")).toEqual({
      request: "watch Discord and file bugs into Linear",
    });
    expect(parseSetupCommand("/setup\nevery 5 minutes")).toEqual({ request: "every 5 minutes" });
  });

  it("ignores ordinary chat that only mentions the word", () => {
    expect(parseSetupCommand("please setup a routine")).toBeNull();
    expect(parseSetupCommand("use /setup later")).toBeNull();
    expect(parseSetupCommand("/setupx")).toBeNull();
    expect(parseSetupCommand("")).toBeNull();
  });
});

describe("expandSetupTurnText", () => {
  it("turns a bare /setup into a request to set up, and keeps a described job", () => {
    expect(expandSetupTurnText("/setup")).toBe(
      "Set yourself up. Ask me what you need to know, then propose your configuration.",
    );
    expect(expandSetupTurnText("/setup watch Discord")).toBe("Set yourself up for this job: watch Discord");
    expect(expandSetupTurnText("hello")).toBe("hello");
  });
});

describe("setupModeActive", () => {
  it("does not turn an ordinary request into onboarding for a blank bot", () => {
    for (const text of ["hello", "Summarize this report", "Run the daily check", "A teammate asked you to review this diff"]) {
      expect(setupModeActive({ soul: "", description: "", text })).toBe(false);
      expect(setupModeActive({ soul: "  \n", description: undefined, text })).toBe(false);
      expect(setupModeActive({ text })).toBe(false);
    }
  });

  it("requires /setup whether or not the profile has been filled in", () => {
    expect(setupModeActive({ text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "hello" })).toBe(false);
    expect(setupModeActive({ soul: "", description: "Files bugs.", text: "hello" })).toBe(false);
    expect(setupModeActive({ soul: "Be brief.", description: "Files bugs.", text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "/setup change my job" })).toBe(true);
  });
});

describe("setupSystemPrompt", () => {
  it("is empty when not active, regardless of the skills option", () => {
    for (const [, connectedApps] of EVERY_STATE) {
      expect(setupSystemPrompt(false, { connectedApps })).toBe("");
      expect(setupSystemPrompt(false, { skills: true, connectedApps })).toBe("");
    }
  });

  it("is the skill_manage-naming block when active with skills on", () => {
    const prompt = setupSystemPrompt(true, { skills: true, connectedApps: AVAILABLE });
    expect(prompt.startsWith("\n\n")).toBe(true);
    for (const tool of ["propose_profile", "create_trigger", "skill_manage", "request_credential"]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain("at most four questions");
    expect(prompt).toContain("Ask for missing choices, not an extra yes");
  });

  it("never mentions skill_manage when active with skills off (or unspecified)", () => {
    for (const prompt of [setupSystemPrompt(true, { connectedApps: AVAILABLE }), setupSystemPrompt(true, { skills: false, connectedApps: AVAILABLE })]) {
      expect(prompt).not.toContain("skill_manage");
      expect(prompt).toContain("propose_profile");
      expect(prompt).toContain("create_trigger");
      expect(prompt).toContain("request_credential");
      expect(prompt).toContain("describe procedures plainly in your standing instructions");
    }
  });
});

describe("setupSystemPrompt working-folder clause and result ordering", () => {
  it("names the current folder and tells the bot to offer to keep it", () => {
    const text = setupSystemPrompt(true, { skills: true, cwd: "/Users/me/Projects/site", connectedApps: AVAILABLE });
    expect(text).toContain("today that is /Users/me/Projects/site; offer to keep it");
    expect(text).toContain("propose_profile for your identity, standing rules");
    expect(text).toContain("and the working folder (cwd)");
  });

  it("says there is no folder yet when the bot works in its private workspace", () => {
    const text = setupSystemPrompt(true, { skills: false, connectedApps: AVAILABLE });
    expect(text).toContain("today it has none and works in a private workspace");
    expect(text).not.toContain("skill_manage");
  });

  it("explains the requested changes before tools and follows applied versus pending outcomes", () => {
    const text = setupSystemPrompt(true, { connectedApps: AVAILABLE });
    expect(text).toContain("First send one message describing the changes you are about to request, then make the tool calls");
    expect(text).toContain("if applied, continue without another confirmation");
    expect(text).toContain("if pending, end the turn and wait");
    expect(text).toContain("Do not repeat the list or claim success from the permission mode alone");
    expect(text).toContain("A credential request still needs the user's secure entry");
    expect(text).toContain("Full Access does not supply answers, credentials, or broader permissions for another bot");
    expect(text).not.toContain("each of which the user must confirm");
    expect(text).not.toContain("propose it paused");
  });
});

describe("setupSystemPrompt for a Chief of Staff", () => {
  it("tells a Chief to stay the Chief and add the job to what it already does", () => {
    const chief = setupSystemPrompt(true, { chief: true, connectedApps: AVAILABLE });
    expect(chief).toContain("You are also the Chief of Staff, and setting yourself up does not change that");
    expect(chief).toContain("add this job to your standing instructions instead of replacing them");
    for (const prompt of [setupSystemPrompt(true, { connectedApps: AVAILABLE }), setupSystemPrompt(true, { chief: false, connectedApps: AVAILABLE })]) {
      expect(prompt).not.toContain("Chief of Staff");
    }
    expect(setupSystemPrompt(false, { chief: true, connectedApps: AVAILABLE })).toBe("");
  });
});

describe("connectedAppsForSetup", () => {
  const facts = { mounted: true, engine: true, configured: true, enabled: true, grants: undefined, host: "server" as const };

  it("is available when the turn mounted the tools and the bot has any connected-app tools", () => {
    expect(connectedAppsForSetup(facts)).toEqual({ state: "available" });
    expect(connectedAppsForSetup({ ...facts, grants: { gmail: { tools: "*" } } })).toEqual({ state: "available" });
  });

  it("is off when this bot's switch is off or it was given no tools, even with the tools mounted", () => {
    expect(connectedAppsForSetup({ ...facts, mounted: false, enabled: false })).toEqual({ state: "off", noTools: false });
    expect(connectedAppsForSetup({ ...facts, grants: {} })).toEqual({ state: "off", noTools: true });
    expect(connectedAppsForSetup({ ...facts, mounted: false, enabled: false, grants: {} })).toEqual({ state: "off", noTools: true });
  });

  it("is not configured when there is no connection service, saying where the bot runs", () => {
    for (const host of ["server", "desktop", "cloud"] as const) {
      expect(connectedAppsForSetup({ ...facts, mounted: false, configured: false, enabled: false, host }))
        .toEqual({ state: "not-configured", host });
    }
    expect(connectedAppsForSetup({ ...facts, mounted: false, host: "desktop" })).toEqual({ state: "not-configured", host: "desktop" });
  });

  it("is unsupported when the bot's model cannot mount connected apps at all", () => {
    expect(connectedAppsForSetup({ ...facts, mounted: false, engine: false })).toEqual({ state: "unsupported" });
    expect(connectedAppsForSetup({ ...facts, mounted: false, engine: false, configured: false, enabled: false })).toEqual({ state: "unsupported" });
  });
});

describe("setupSystemPrompt connected apps", () => {
  const prompt = (connectedApps: SetupConnectedApps) => setupSystemPrompt(true, { connectedApps });

  it("starts the connection in this same turn when the tools are mounted, instead of sending the user to settings", () => {
    const text = prompt(AVAILABLE);
    expect(text).toContain("yourself rather than sending the user to settings");
    expect(text).toContain("in this same turn, even with questions still open, make COMPOSIO_MANAGE_CONNECTIONS for its toolkit (for example gmail) your last tool call");
    expect(text).toContain("The user gets a Connect card in this chat; end the turn there, and you continue automatically once it is connected.");
  });

  it("names the one switch the person flips when connected apps are off for this bot", () => {
    expect(prompt({ state: "off", noTools: false })).toContain(
      "ask the user to turn on Connected apps in your settings under Access, then tell you to go on",
    );
    expect(prompt({ state: "off", noTools: true })).toContain(
      "ask the user to open your settings → Access → Connected apps, turn it on, connect the app with Connect an app…, and give you its tools",
    );
  });

  it("says in one sentence where connected apps are set up when this OpenMausBot has none", () => {
    expect(prompt({ state: "not-configured", host: "server" })).toContain(
      "Connected apps are not set up here, so you cannot connect an app such as Gmail yourself. If the job needs one, say so in one sentence: they are set up by adding a Composio project key in Settings → API keys, under Self-host connected apps.",
    );
    expect(prompt({ state: "not-configured", host: "desktop" })).toContain(
      "restarting OpenMausBot usually brings them back, or they can add their own Composio project key in Settings → API keys, under Self-host connected apps.",
    );
    const cloud = prompt({ state: "not-configured", host: "cloud" });
    expect(cloud).toContain("Connected apps come with their MausBot Cloud plan but are not answering right now");
    expect(cloud).not.toContain("Composio");
    expect(prompt({ state: "unsupported" })).toContain("Your current model cannot use connected apps");
  });

  it("never names a connected-app tool the turn did not mount", () => {
    for (const [name, connectedApps] of EVERY_STATE) {
      const text = prompt(connectedApps);
      if (connectedApps.state === "available") expect(text, name).toContain("COMPOSIO_MANAGE_CONNECTIONS");
      else expect(text, name).not.toMatch(/COMPOSIO_/);
      expect(text, name).not.toContain("skill_manage");
    }
  });

  it("never defers app authorization to the Access section, and keeps the by-hand ending for what truly needs it", () => {
    for (const [name, connectedApps] of EVERY_STATE) {
      const text = prompt(connectedApps);
      expect(text, name).not.toContain("point them to the Access section");
      expect(text, name).not.toContain("(OAuth)");
      expect(text, name).toContain(
        "Finish by saying exactly what remains for the user to do by hand, such as creating a third-party application or bot token, or deciding a pending review.",
      );
    }
  });

  it("sends a website sign-in to request_sign_in, never a password in chat, and Google accounts only through connected apps", () => {
    for (const [name, connectedApps] of EVERY_STATE) {
      const text = prompt(connectedApps);
      expect(text, name).toContain("For a website no connected app covers, call request_sign_in at its sign-in page so the user signs in themselves");
      expect(text, name).toContain("never ask for a password or code in chat");
      expect(text, name).toContain("Gmail and other Google accounts only connect through connected apps: Google blocks sign-in in your browser.");
    }
  });
});
