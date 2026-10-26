import { describe, expect, it } from "vitest";

import en from "./en.json";

const english = en as Record<string, string>;

const EVERYDAY_PREFIXES: Record<string, readonly string[]> = {
  "the chat and the composer": [
    "chat.", "composer.", "attach.", "toolStep.", "approval.", "question.", "signIn.", "limits.", "call.", "task.", "room.",
  ],
  "notifications and alerts": ["attention.", "notifications.", "error.", "readyBots.", "app.loading."],
  "the sidebar and the switcher": ["sidebar."],
  "the bot panel": [
    "botPanel.", "botSettings.simple.", "botAccess.tools.", "botAccess.browser.", "memory.learnFromRooms.", "memory.upkeep.",
  ],
  "the Screen panel and where a bot works": [
    "place.", "computer.tab.", "computer.simple.", "computer.phase.", "computer.cloud.", "computer.badge.", "computer.problem.",
    "computer.screen.", "vm.cloud.", "browser.",
  ],
  "MausBot Cloud: buying it, setting it up, moving to it and sharing with it": [
    "cloudBuy.", "cloudIntro.", "cloudTrial.", "cloudSetup.", "cloudIntent.", "cloudNotice.", "cloudHowTo.", "cloudScene.", "cloudProPopup.",
    "cloudCredit.", "cloudPower.", "cloudSignIn.", "cloudAdd.", "cloudHome.", "cloudPhone.", "cloudAccount.", "pro.", "lending.",
    "files.", "usageMeter.",
  ],
  "routines and automations": ["routines.", "automations."],
  "the team map": ["canvas.", "mapComputer.", "canvasComputers."],
  "Apps": ["apps.", "connectors."],
  "the Settings pages Simple mode shows": ["settings.section.", "settings.group.", "settings.mcpCalls.", "settings.logins."],
  "the Usage page and its traces": ["trace.", "usage.page."],
};

const EVERYDAY_KEYS: Record<string, readonly string[]> = {
  "the Screen panel": [
    "computer.close", "computer.sleepTitle", "computer.capturingVm", "computer.capturingLocal", "computer.chooseCloudWake",
    "computer.chooseCloudOpen", "computer.chooseCloudManage", "computer.autoChooseCloudOpen", "computer.createVm", "computer.replaceVm",
    "computer.openVmSetup", "computer.confirm.replaceVm", "computer.err.emptyFrame", "computer.err.frameTimeout", "computer.err.noDesktopLink",
    "computer.err.vmNotReady", "computer.err.vmEngine", "computer.err.localEngine", "computer.err.vmOpenSettings", "computer.worksOnHint",
    "computer.worksOnHintCloudHome", "computer.linux.waylandAfter", "vm.dest.vm", "vm.setup.start", "vm.setup.starting", "vm.stopped.detail",
    "vm.stopped.idle",
  ],
  "the bot panel": [
    "botOverview.line.computer", "botOverview.line.privateWorkspace", "botOverview.preference.cloud", "botOverview.preference.vm",
    "botSettings.replyStyle.conversationalHint", "voice.engine",
  ],
  "adding and sharing a bot": ["newBot.presetKeeps", "presetShare.never"],
  "signing in to an AI, the Cloud's own sign-in included": [
    "engineSetup.claude.description", "engineSetup.claude.connectedAccount", "engineSetup.device.description", "engineSetup.device.security",
    "engineSetup.device.connectedAccount", "engineSetup.device.failed", "engineSetup.device.enableHint", "engineSetup.grok.description",
    "engineSetup.grok.security", "engineSetup.grok.connectedAccount", "engineSetup.grok.failed", "engineSetup.grok.notInstalled",
    "engineSetup.serverInstall", "engineSetup.serverUpdate", "engineSetup.serverInstalling", "engineSetup.sendRedirect",
    "engineSetup.sameMachine", "engineSetup.invalidStatus", "engines.account.signInHint", "engines.trialCredit", "engines.trialCreditEnded",
    "grokFinish.messageApps", "keys.cerebras.desc", "keys.groq.desc", "keys.meta.desc",
  ],
  "the Settings pages Simple mode shows": [
    "settings.diagnostics.subtitle", "settings.diagnostics.elsewhere", "settings.import.appsSubtitle", "settings.profiles.temporaryHint",
    "settings.profiles.myChromeUnavailable", "remote.serverPairing.cloudPersonal", "remote.serverPairing.error",
  ],
};

type Word = { word: string; pattern: RegExp; say: string };

const INTERNAL_WORDS: readonly Word[] = [
  { word: "engine", pattern: /\bengines?\b/i, say: "AI" },
  { word: "instance", pattern: /\binstances?\b/i, say: "AI account" },
  { word: "server", pattern: /(?<!(?:Discord|Slack|MCP) )\bservers?\b/i, say: "the app, or the Cloud when it is hosted" },
  { word: "Composio", pattern: /composio/i, say: "connected apps" },
  { word: "Cloud computer", pattern: /\bcloud computers?\b/i, say: "cloud desktop" },
  { word: "VPS", pattern: /\bVPS\b/, say: "your own machine" },
  { word: "Local VM", pattern: /\bLocal VMs?\b/i, say: "private desktop" },
  { word: "workspace", pattern: /\bworkspaces?\b/i, say: "installation, or leave it out" },
];

const PENDING_WORDS: readonly Word[] = [
  { word: "This computer", pattern: /\bThis computer\b/, say: "this Mac or this PC" },
  { word: "My Cloud", pattern: /\bMy Cloud\b/, say: "the Cloud" },
  { word: "lent", pattern: /\b(?:lent|lends?|lending)\b/i, say: "shared, or let … use" },
];

const ALLOWED: Record<string, string> = {
  "settings.section.desktopWorkspaces": "the Servers page shares its name with the app menu's Server menu; both change with the one-workspace switcher",
  "sidebar.servers": "the switcher's own Servers list, renamed with the one-workspace switcher",
  "sidebar.switchServer": "the switcher's own Servers list, renamed with the one-workspace switcher",
  "sidebar.switchServerError": "points at the app menu's Server menu",
  "cloudPhone.step1": "points at the app menu's Server menu, entry by entry",
  "lending.viaAccess": "points at the Settings → Servers page by its label",
  "lending.viaAccessTerminal": "points at the Settings → Servers page by its label",
  "botAccess.tools.syntax": "the tool names people type, such as mcp:SERVER:NAME",
};

const prefixes = Object.values(EVERYDAY_PREFIXES).flat();
const keys = Object.values(EVERYDAY_KEYS).flat();
const everyday = (key: string) => keys.includes(key) || prefixes.some((prefix) => key.startsWith(prefix));
const prose = (text: string) => text.replace(/\{\w+\}/g, "").replace(/`[^`]*`/g, "");
const wordsIn = (text: string, words: readonly Word[] = INTERNAL_WORDS) =>
  words.filter(({ pattern }) => pattern.test(prose(text))).map(({ word, say }) => `"${word}" (say ${say})`);

describe("everyday screens", () => {
  it("say what a person knows instead of the app's internal words", () => {
    const offending = Object.entries(english)
      .filter(([key]) => everyday(key) && !Object.hasOwn(ALLOWED, key))
      .flatMap(([key, text]) => wordsIn(text).map((what) => `${key}: ${what}`));
    expect(offending).toEqual([]);
  });

  it("list only keys and prefixes that exist, and allow only everyday keys that still need it", () => {
    const all = Object.keys(english);
    expect(keys.filter((key) => !Object.hasOwn(english, key))).toEqual([]);
    expect(prefixes.filter((prefix) => !all.some((key) => key.startsWith(prefix)))).toEqual([]);
    const stale = Object.keys(ALLOWED).filter((key) => !Object.hasOwn(english, key) || !everyday(key) || wordsIn(english[key]!).length === 0);
    expect(stale).toEqual([]);
  });

  it("catch each internal word, and let placeholders, commands, MCP servers and Discord or Slack servers through", () => {
    for (const bad of [
      "Switch to another engine", "Add an instance", "Restart the server", "Connect apps through Composio",
      "Start the cloud computer", "Self-hosted VPS", "Create Local VM", "Choose a workspace",
    ]) expect(wordsIn(bad), bad).not.toEqual([]);
    for (const good of [
      "Switch this bot to another AI", "Pick a Discord server", "Post in your Slack servers", "Copy to {server}",
      "Run `openmausbot server start`", "Open the Cloud", "Start the cloud desktop", "Your MCP servers", "Add MCP server", "Private desktop",
    ]) expect(wordsIn(good), good).toEqual([]);
  });

  for (const { word, pattern, say } of PENDING_WORDS) {
    const left = Object.entries(english).filter(([key, text]) => everyday(key) && pattern.test(prose(text))).length;
    it.todo(`"${word}" (say ${say}), still in ${left} everyday keys, once the screens that name it are rebuilt`);
  }
});
