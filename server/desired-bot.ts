import { approvalModeFor } from "../shared/approval-mode.ts";
import type { EduBrainSetting } from "../shared/edu-brain.ts";
import { lineDiff } from "../shared/line-diff.ts";
import type { ToolGroup } from "../shared/tool-groups.ts";
import type { ToolScope } from "../shared/tool-scope.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";

type Rec = Record<string, any>;

export interface DesiredSkill { name: string; description: string; text: string; enabled: boolean; file: string }

/** A bot as a team file or a profile wants it. An absent field is left as the bot has it. */
export interface DesiredBot {
  name: string;
  was?: string;
  team?: string;
  title?: string;
  description?: string;
  /** true: the Chief of Staff of its team; false: not; absent: left as it is. */
  chief?: boolean;
  manages: string[];
  soul?: string;
  model?: { instanceId: string; model: string };
  effort?: string;
  approval?: "ask" | "edits" | "auto" | "full";
  computer?: "auto" | "off" | "browser" | "local" | "vm" | "cloud";
  cwd?: string;
  browser?: { enabled: boolean; profile?: string };
  /** null: no selection, so every tool (a file's `tools: {}` or `{ deny: [] }`). */
  tools?: ToolScope | null;
  toolsOff?: ToolGroup[];
  mcpServers?: string[];
  connectorTools?: Record<string, ConnectorToolGrant>;
  eduBrain?: EduBrainSetting;
  eduCrew?: boolean;
  memoryEnabled?: boolean;
  memoryUpkeep?: boolean;
  skills: DesiredSkill[];
}

export const APPROVAL_LABEL: Record<string, string> = { ask: "Ask", edits: "Accept edits", auto: "Auto", full: "Full access", custom: "Custom" };

const key = (name: string | undefined) => (name ?? "").trim().toLowerCase();
const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
const sorted = (list: readonly string[] | undefined) => [...new Set(list ?? [])].sort();
const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const onOff = (on: boolean) => (on ? "on" : "off");

export function everyTool(scope: { allow?: unknown; deny?: unknown } | null | undefined): boolean {
  return !scope || (!Array.isArray(scope.allow) && !(Array.isArray(scope.deny) && scope.deny.length > 0));
}

export const canonicalScope = (scope: Rec | null | undefined) => everyTool(scope) ? "every tool"
  : JSON.stringify(Object.fromEntries(["allow", "deny"].filter((field) => Array.isArray(scope![field])).map((field) => [field, [...new Set(scope![field] as string[])].sort()])));

export function canonicalGrants(grants: Record<string, ConnectorToolGrant> | undefined | null): string {
  if (!grants) return "every app";
  return JSON.stringify(Object.keys(grants).sort().map((slug) => [slug, grants[slug]!.tools === "*" ? "*" : sorted(grants[slug]!.tools as string[])]));
}

export function changedLines(before: string, after: string): number {
  const diff = lineDiff(before.trimEnd(), after.trimEnd());
  return Math.max(diff.filter((line) => line.startsWith("+")).length, diff.filter((line) => line.startsWith("-")).length);
}

/** The PATCH that brings `echo` (a bot as GET /api/bots returns it) to `desired`, and one phrase per change. */
export function botPatch(desired: DesiredBot, echo: Rec, team: string | undefined): { patch: Rec; changes: string[] } {
  const patch: Rec = {};
  const changes: string[] = [];
  if (echo.name !== desired.name) { patch.name = desired.name; changes.push(`renamed from "${echo.name}"`); }
  if (team !== undefined && key(echo.section) !== key(team)) { patch.section = team; changes.push(`team "${echo.section ?? "none"}" → "${team}"`); }
  if (desired.title !== undefined && (echo.title ?? "") !== desired.title) { patch.title = desired.title; changes.push(`title "${echo.title ?? ""}" → "${desired.title}"`); }
  if (desired.description !== undefined && (echo.description ?? "") !== desired.description) { patch.description = desired.description; changes.push("description changed"); }
  if (desired.soul !== undefined && (echo.soul ?? "").trimEnd() !== desired.soul.trimEnd()) {
    patch.soul = desired.soul.trimEnd();
    changes.push(echo.soul ? `soul ${lines(changedLines(echo.soul ?? "", desired.soul))} changed` : `soul set (${lines(desired.soul.trimEnd().split("\n").length)})`);
  }
  if (desired.model || desired.effort) {
    const current: Rec = echo.modelSelection ?? {};
    const instanceId = desired.model?.instanceId ?? current.instanceId;
    const model = desired.model?.model ?? current.model;
    if (current.instanceId !== instanceId || current.model !== model || (desired.effort !== undefined && current.effort !== desired.effort)) {
      const effort = desired.effort ?? (instanceId === current.instanceId ? current.effort : undefined);
      patch.modelSelection = { instanceId, model, ...(effort ? { effort } : {}) };
      patch.requireAvailableModel = true;
      changes.push(`model ${current.instanceId}/${current.model}${current.effort ? ` (${current.effort})` : ""} → ${instanceId}/${model}${effort ? ` (${effort})` : ""}`);
    }
  }
  const approval = approvalModeFor(echo);
  if (desired.approval && approval !== desired.approval) {
    patch.approvalMode = desired.approval;
    patch.applyToAllThreads = true;
    changes.push(`approval ${APPROVAL_LABEL[approval]} → ${APPROVAL_LABEL[desired.approval]}`);
  }
  const computer = echo.computer ?? "auto";
  if (desired.computer && computer !== desired.computer) {
    patch.computer = desired.computer === "auto" ? null : desired.computer;
    changes.push(`computer ${computer} → ${desired.computer}`);
  }
  // A team file is the confirmation the server asks for to leave a bot on Auto on this computer.
  if ((patch.computer !== undefined || patch.approvalMode !== undefined) && (desired.computer ?? computer) === "local" && (desired.approval ?? approval) === "auto") {
    patch.acknowledgeLocalAuto = true;
  }
  if (desired.cwd && echo.cwd !== desired.cwd) { patch.cwd = desired.cwd; changes.push(`folder ${echo.cwd ?? "default"} → ${desired.cwd}`); }
  if (desired.browser) {
    if ((echo.browser !== false) !== desired.browser.enabled) { patch.browser = desired.browser.enabled; changes.push(`browser ${desired.browser.enabled ? "on" : "off"}`); }
    if (desired.browser.profile !== undefined && echo.browserProfile !== desired.browser.profile) {
      patch.browserProfile = desired.browser.profile;
      changes.push(`browser profile ${echo.browserProfile ?? "its own"} → ${desired.browser.profile}`);
    }
  }
  if (desired.tools !== undefined && canonicalScope(echo.toolScope) !== canonicalScope(desired.tools)) {
    // null clears the selection on the server: every tool
    patch.toolScope = desired.tools;
    changes.push(desired.tools === null ? "tools: every tool" : "tools changed");
  }
  if (desired.toolsOff !== undefined && !sameList(echo.toolsOff, desired.toolsOff)) {
    patch.toolsOff = sorted(desired.toolsOff);
    changes.push(desired.toolsOff.length ? `tool groups off: ${sorted(desired.toolsOff).join(", ")}` : "every tool group on");
  }
  if (desired.mcpServers !== undefined && !(Array.isArray(echo.mcpServers) && sameList(echo.mcpServers, desired.mcpServers))) {
    patch.mcpServers = sorted(desired.mcpServers);
    changes.push(desired.mcpServers.length ? `MCP servers: ${sorted(desired.mcpServers).join(", ")}` : "no MCP servers");
  }
  if (desired.connectorTools !== undefined && canonicalGrants(echo.connectorTools) !== canonicalGrants(desired.connectorTools)) {
    patch.connectorTools = desired.connectorTools;
    const apps = Object.keys(desired.connectorTools).sort();
    changes.push(apps.length ? `connected apps: ${apps.join(", ")}` : "no connected apps");
  }
  if (desired.eduBrain !== undefined && (echo.eduBrain?.mode ?? "own") !== desired.eduBrain.mode) {
    patch.eduBrain = desired.eduBrain;
    changes.push(`Edu brain ${echo.eduBrain?.mode ?? "own"} → ${desired.eduBrain.mode}`);
  }
  if (desired.eduCrew !== undefined && (echo.eduCrew === true) !== desired.eduCrew) { patch.eduCrew = desired.eduCrew; changes.push(`Edu crew ${onOff(desired.eduCrew)}`); }
  if (desired.memoryEnabled !== undefined && (echo.memoryEnabled !== false) !== desired.memoryEnabled) {
    patch.memoryEnabled = desired.memoryEnabled;
    changes.push(`memory ${onOff(desired.memoryEnabled)}`);
  }
  if (desired.memoryUpkeep !== undefined && (echo.memoryUpkeep !== false) !== desired.memoryUpkeep) {
    patch.memoryUpkeep = desired.memoryUpkeep;
    changes.push(`memory upkeep ${onOff(desired.memoryUpkeep)}`);
  }
  return { patch, changes };
}
