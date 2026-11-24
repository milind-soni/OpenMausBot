// Security invariant: what a bot may do (its approval level, grants, tools, apps, folders, who may reach it) is on disk
// after the next save of bots.json, whichever bot that save names. A save that serializes only the bots it names
// compares this digest of every other bot with the one from the last write and serializes again any bot whose digest
// moved, so a permission changed in place without naming its bot (a revocation above all) is never left out.
import type { BotRecord, TaskRecord } from "./store.ts";

export const BOT_SAFETY_FIELDS = [
  "approvalMode", "autoApprove", "alwaysAllow", "approvalGrant", "toolScope", "toolsOff", "connectorTools", "connectorScopes",
  "outbound", "composio", "computer", "cloudBackend", "browser", "browserProfile", "mcpServers", "phoneApps", "cwd",
  "chiefOfStaff", "managedSections", "reportsTo", "visibility", "access", "onlyPeopleAdded", "createdBy", "hidden",
] as const satisfies readonly (keyof BotRecord)[];

export const THREAD_SAFETY_FIELDS = [
  "approvalMode", "autoApprove", "alwaysAllow", "cwd", "private", "shared", "sharedChat",
] as const satisfies readonly (keyof TaskRecord)[];

export function botSafetyDigest(bot: BotRecord): string {
  const parts: string[] = [];
  for (const key of BOT_SAFETY_FIELDS) if (bot[key] !== undefined) parts.push(key, JSON.stringify(bot[key]) ?? "");
  for (const task of bot.tasks ?? []) {
    let named = false;
    for (const key of THREAD_SAFETY_FIELDS) {
      if (task[key] === undefined) continue;
      if (!named) parts.push(`#${task.threadId}`);
      named = true;
      parts.push(key, JSON.stringify(task[key]) ?? "");
    }
  }
  return parts.join("\u0000");
}
