import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import en from "./en.json";

it("English copy says Organization and installation, not Organisation or workspace", () => {
  const offending = Object.entries(en)
    .filter(([, value]) => /organis/i.test(value) || /(?<!Slack )\bworkspaces?\b/i.test(value))
    .map(([key]) => key);
  expect(offending).toEqual([]);
});

// Identifiers, IPC channels and error codes keep "workspace", so the guard names retired phrases, not the word.
const HARDCODED = [
  "electron/environments.cjs", "electron/main.mjs", "electron/computer-sharing.mjs", "electron/shared-computer-access.mjs",
  "electron/company-backups.mjs", "electron/company-backup-schedule.mjs", "electron/managed-desktop.mjs", "electron/organization-entry.mjs",
  "src/components/DesktopWorkspaceSwitcher.tsx", "src/components/ConnectedWorkspacesSettings.tsx", "src/components/LocalVmWorkspace.tsx",
  "src/components/VoiceSettings.tsx", "src/components/bot-settings/AccessSection.tsx", "src/components/CompanyBackupSettings.tsx",
  "src/components/BrowserPanel.tsx", "src/lib/call-capability.ts", "server/container-computer.ts",
];
const RETIRED = [
  "hosted workspace", "Switch workspace", "Could not open workspaces", "Your workspaces", "Workspace address", "Connect workspace",
  "load saved workspaces", "Saved workspaces", "Loading workspaces", "Switching workspaces", "workspace connection", "update workspaces",
  "HTTPS workspace address", "Workspace sign-in", "workspace pairing", "another workspace", "for this workspace", "with this workspace",
  "Connected workspaces", "Workspace controls", "`Workspace: ", "Workspace response", "Workspace request", "The selected workspace",
  "this workspace’s bots", "Bots from this workspace", "This workspace is no longer",
  "local workspace", "Local workspace", "workspace replacement", "Your workspace has", "The workspace changed", "The workspace could not",
  "entire workspace", "encrypted workspace backup", "when the workspace is", "Workspace default", "shared by the workspace", "workspace administrators",
  "Private bot workspace", "durable workspace", "Local VM workspace", "two-desktop workspace", "desktop workspace bridge",
  "desktop workspace belongs", "desktop workspace is available", "The workspace stayed open",
  "Organisation sign-in", "organisation sign-in", "your organisation", "an organisation", "organisation's Admin", "organisation connection",
];

it("hardcoded copy does not bring back the retired workspace and Organisation phrases", () => {
  const offending = HARDCODED.flatMap((file) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    return RETIRED.filter((phrase) => source.includes(phrase)).map((phrase) => `${file}: ${phrase}`);
  });
  expect(offending).toEqual([]);
});

it("English welcome flow copy has no em dashes", () => {
  const offending = Object.entries(en)
    .filter(([key, value]) => key.startsWith("onboarding.") && value.includes("—"))
    .map(([key]) => key);
  expect(offending).toEqual([]);
});
