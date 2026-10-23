import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";
import { niceTime, scheduleLabel } from "@/lib/schedule-label";
import type { OverviewRoutineLine } from "@/lib/bot-overview-types";

const LAST_RUN: Record<string, LocaleKey> = {
  completed: "botOverview.routine.last.completed", failed: "botOverview.routine.last.failed", missed: "botOverview.routine.last.missed",
  cancelled: "botOverview.routine.last.cancelled", running: "botOverview.routine.last.running", queued: "botOverview.routine.last.queued",
  waiting: "botOverview.routine.last.waiting",
};

export function overviewRoutineText(routine: OverviewRoutineLine | undefined, locale = activeLocale()): string | null {
  if (!routine || locale === "en") return null;
  if (routine.paused) return t("botOverview.routine.paused", { name: routine.name });
  const last = routine.lastRun;
  if (last && !Object.hasOwn(LAST_RUN, last.status)) return null;
  try {
    return [
      t("botOverview.routine.line", { schedule: scheduleLabel(routine.schedule), name: routine.name }),
      ...(routine.nextRunAt != null ? [t("botOverview.routine.next", { time: niceTime(routine.nextRunAt) })] : []),
      ...(last ? [t(LAST_RUN[last.status]!, { time: niceTime(last.at) })] : []),
    ].join(" ");
  } catch {
    return null;
  }
}

const EXACT: Record<string, LocaleKey> = {
  "Works in its private workspace.": "botOverview.line.privateWorkspace",
  "Has the built-in browser.": "botOverview.line.browser",
  "Has no connected apps.": "botOverview.line.noApps",
  "Won't act on a schedule.": "botOverview.line.noSchedule",
  "Cannot initiate contact with other bots.": "botOverview.line.noPeerContact",
  "Command approvals use Ask mode; saved permissions and provider rules still apply.": "botOverview.line.askMode",
  "Command approvals follow the provider's custom configuration.": "botOverview.line.customApprovals",
  "Asks before contacting other bots.": "botOverview.line.asksPeers",
  "Can't use a computer.": "botOverview.line.noComputer",
  "Profile proposal cards require your approval.": "botOverview.line.profileApproval",
  "Connected apps could not be checked.": "botOverview.line.appsUnchecked",
};

const PREFERENCE: Record<string, LocaleKey> = {
  "Auto; availability is checked when a task starts": "botOverview.preference.auto",
  "cloud computer": "botOverview.preference.cloud",
  "Local VM": "botOverview.preference.vm",
  "this computer": "botOverview.preference.local",
  "browser only": "botOverview.preference.browser",
};

/** Only the unnamed section, which the server marks with "" in `managedSections`, gets its label; every name is data. */
function managedTeams(english: string, managedSections: readonly string[] | undefined): string {
  if (!managedSections || managedSections.map((name) => name || "General").join(", ") !== english) return english;
  return managedSections.map((name) => name || t("botAccess.teams.general")).join(", ");
}

const preference = (words: string): string => (Object.hasOwn(PREFERENCE, words) ? t(PREFERENCE[words]!) : words);

export function overviewLineText(line: string, managedSections?: readonly string[]): string {
  if (Object.hasOwn(EXACT, line)) return t(EXACT[line]!);
  if (line === "Coordinates its section as Chief of Staff.") return t("botOverview.line.chief", { role: t("sidebar.bot.chiefOfStaff") });
  const peers = /^Can talk to (\d+) other bots? in (its section|its allowed teams)\.$/.exec(line);
  if (peers) {
    const count = Number(peers[1]), teams = peers[2] === "its allowed teams";
    return t(count === 1 ? (teams ? "botOverview.line.peersTeamsOne" : "botOverview.line.peersSectionOne") : (teams ? "botOverview.line.peersTeamsMany" : "botOverview.line.peersSectionMany"), { count });
  }
  const apps = /^Can use (\d+) connected apps?: (.+)\.$/.exec(line);
  if (apps) return t(apps[1] === "1" ? "botOverview.line.appsOne" : "botOverview.line.appsMany", { count: Number(apps[1]), apps: apps[2]! });
  const teams = /^May also coordinate these teams: (.+)\.$/.exec(line);
  if (teams) return t("botOverview.line.alsoTeams", { teams: managedTeams(teams[1]!, managedSections) });
  const away = activeLocale() === "en" ? null : /^Computer preference: (.+), which isn't available on My Cloud\.$/.exec(line);
  if (away) return t("botOverview.line.computerNotOnCloud", { preference: preference(away[1]!) });
  const computer = /^Computer preference: (.+)\.$/.exec(line);
  if (computer) return t("botOverview.line.computer", { preference: preference(computer[1]!) });
  const folder = /^Works in (.+)\.$/.exec(line);
  if (folder) return t("botOverview.line.folder", { folder: folder[1]! });
  const skill = /^Knows how to (.+)\.$/.exec(line);
  if (skill) return t("botOverview.line.skill", { skill: skill[1]! });
  const webhook = /^Listens for “(.+)” webhooks\.$/.exec(line);
  if (webhook) return t("botOverview.line.webhook", { name: webhook[1]! });
  return line;
}

const HISTORY_FIELD: Record<string, LocaleKey> = {
  name: "approval.applied.field.name", title: "approval.applied.field.title", description: "approval.applied.field.description",
  soul: "approval.applied.field.soul", cwd: "approval.applied.field.cwd", notifications: "approval.applied.field.notifications",
  speakReplies: "approval.applied.field.speakReplies",
};

export function recentChangeText(summary: string, locale = activeLocale()): string {
  const field = /^(\w+): /.exec(summary)?.[1];
  return locale === "en" || !field || !Object.hasOwn(HISTORY_FIELD, field) ? summary : `${t(HISTORY_FIELD[field]!)}: ${summary.slice(field.length + 2)}`;
}
