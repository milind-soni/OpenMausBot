import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import en from "./en.json";

// The product words: the tenant is an "Organization" (US spelling, as in
// Admin), and one running OpenMausBot is an "installation". A remote one saved
// in the desktop is a "server" and a bot's or task's directory is a "folder".
// "Workspace" survives only as Slack's own term, or another product's term.
const ALLOWED = new Set([
  "engines.account.apiKey", // the Anthropic Console's "workspace API key"
  "engineSetup.device.enableHint", // a ChatGPT "workspace admin"
  // Keys another branch adds with its own wording go here until reviewed.
]);

it("English copy says Organization and installation, not Organisation or workspace", () => {
  const offending = Object.entries(en)
    .filter(([key, value]) => !ALLOWED.has(key) && (/organis/i.test(value) || /(?<!Slack )\bworkspaces?\b/i.test(value)))
    .map(([key]) => key);
  expect(offending).toEqual([]);
});

// Copy that is hardcoded rather than in en.json: menus, native dialogs, errors
// and a few labels. Code identifiers, IPC channels, menu ids and error codes
// keep "workspace", so the guard names the retired phrases, not the word.
const HARDCODED = [
  "electron/environments.cjs", "electron/main.mjs", "electron/computer-sharing.mjs", "electron/shared-computer-access.mjs",
  "electron/company-backups.mjs", "electron/company-backup-schedule.mjs", "electron/managed-desktop.mjs", "electron/organization-entry.mjs",
  "src/components/DesktopWorkspaceSwitcher.tsx", "src/components/ConnectedWorkspacesSettings.tsx", "src/components/LocalVmWorkspace.tsx",
  "src/components/VoiceSettings.tsx", "src/components/bot-settings/AccessSection.tsx", "src/components/CompanyBackupSettings.tsx",
  "src/components/BrowserPanel.tsx", "src/lib/call-capability.ts", "server/container-computer.ts",
];
const RETIRED = [
  // saved servers and the switcher
  "hosted workspace", "Switch workspace", "Could not open workspaces", "Your workspaces", "Workspace address", "Connect workspace",
  "load saved workspaces", "Saved workspaces", "Loading workspaces", "Switching workspaces", "workspace connection", "update workspaces",
  "HTTPS workspace address", "Workspace sign-in", "workspace pairing", "another workspace", "for this workspace", "with this workspace",
  "Connected workspaces", "Workspace controls", "`Workspace: ", "Workspace response", "Workspace request", "The selected workspace",
  "this workspace’s bots", "Bots from this workspace", "This workspace is no longer",
  // this installation, its backups and its admins
  "local workspace", "Local workspace", "workspace replacement", "Your workspace has", "The workspace changed", "The workspace could not",
  "entire workspace", "encrypted workspace backup", "when the workspace is", "Workspace default", "shared by the workspace", "workspace administrators",
  // folders and the two-desktop view
  "Private bot workspace", "durable workspace", "Local VM workspace", "two-desktop workspace", "desktop workspace bridge",
  "desktop workspace belongs", "desktop workspace is available", "The workspace stayed open",
  // US spelling
  "Organisation sign-in", "organisation sign-in", "your organisation", "an organisation", "organisation's Admin", "organisation connection",
];

it("hardcoded copy does not bring back the retired workspace and Organisation phrases", () => {
  const offending = HARDCODED.flatMap((file) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    return RETIRED.filter((phrase) => source.includes(phrase)).map((phrase) => `${file}: ${phrase}`);
  });
  expect(offending).toEqual([]);
});
