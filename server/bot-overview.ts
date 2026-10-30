import type { BotRecord } from "./store.ts";
import type { Routine } from "./routines.ts";
import type { RoutineRequestSchedule } from "../shared/routine-request.ts";
import { approvalModeFor } from "../shared/approval-mode.ts";
import { cronScheduleLabel } from "../shared/cron-label.ts";

export interface BotOverview {
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
  grants?: BotOverviewGrant[];
  setup: SetupStep[];
}

export interface BotOverviewGrant {
  slug: string;
  level: "all" | "partial" | "none";
  /** Granted tool count; 0 unless level is "partial". */
  toolCount: number;
}

export type SetupStepId = "identity" | "soul" | "folder" | "apps" | "schedule";
export type SetupStepSection = "identity" | "soul" | "access" | "routines";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  section?: SetupStepSection;
}

export interface OverviewFacts {
  bot: Pick<
    BotRecord,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "computer"
    | "cloudBackend"
    | "cwd"
    | "autoApprove"
    | "approvalMode"
    | "approvePeerComms"
    | "peers"
    | "composio"
    | "connectorTools"
    | "browser"
    | "chiefOfStaff"
    | "managedSections"
  >;
  routines: Array<{
    id: string;
    name: string;
    enabled: boolean;
    schedule: RoutineRequestSchedule | Routine["schedule"];
    nextRunAt: number | null;
  }>;
  runs: Array<{ routineId: string; status: string; finishedAt?: number; startedAt?: number; scheduledFor: number }>;
  webhooks: Array<{ name: string; enabled: boolean }>;
  skills: Array<{ name: string; description: string; enabled: boolean }>;
  engine: { agentsMcp?: boolean; composioMcp?: boolean; browserMcp?: boolean; computerMcp?: boolean } | null;
  browserEnabled?: boolean;
  cloudHome?: boolean;
  connectedApps: { configured: boolean; authoritative: boolean; services: string[] };
  sectionPeers: number;
  timeZone: string;
  recent: Array<{ at: number; summary: string }>;
}

export function soulLead(soul: string | undefined): string {
  const trimmed = (soul ?? "").trim();
  if (!trimmed) return "";
  const paragraph = (trimmed.split(/\r?\n\s*\r?\n/)[0] ?? trimmed).trim();
  return paragraph.length > 240 ? `${paragraph.slice(0, 240).trimEnd()}…` : paragraph;
}

function lowerFirst(value: string): string {
  return value.length ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function time(at: number, timeZone: string): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clockTime(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map((part) => Number.parseInt(part, 10) || 0);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function schedulePhrase(schedule: OverviewFacts["routines"][number]["schedule"], timeZone: string): string {
  if (schedule.type === "cron") return cronScheduleLabel(schedule);
  if (schedule.type === "once") {
    const date = new Date(schedule.at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone });
    return `Once on ${date} at ${time(schedule.at, timeZone)}`;
  }
  if (schedule.type === "limit_reset") return schedule.repeat === "every_reset" ? "Each time the AI usage limit resets" : "When the AI usage limit resets";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMinutes;
    if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    if (minutes === 60) return "Every hour";
    if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return `Every ${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? "" : "s"} ${minutes % 60} minutes`;
  }
  const days = schedule.weekdays;
  const at = ` at ${clockTime(schedule.time)}`;
  if (days.length === 7) return `Every day${at}`;
  if (days.join(",") === "1,2,3,4,5") return `Every weekday${at}`;
  if (days.length === 1) return `Weekly on ${DAY_NAMES[days[0]!]}${at}`;
  return `${days.map((day) => DAY_NAMES[day]).join(", ")}${at}`;
}

function latestRunFor(runs: OverviewFacts["runs"], routineId: string): OverviewFacts["runs"][number] | undefined {
  let best: OverviewFacts["runs"][number] | undefined;
  let bestAt = -Infinity;
  for (const run of runs) {
    if (run.routineId !== routineId) continue;
    const at = run.finishedAt ?? run.startedAt ?? run.scheduledFor;
    if (at > bestAt) {
      bestAt = at;
      best = run;
    }
  }
  return best;
}

function doesLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  for (const routine of facts.routines) {
    if (!routine.enabled) {
      lines.push(`Paused: ${routine.name}.`);
      continue;
    }
    const nextRun = routine.nextRunAt != null ? ` Next run ${time(routine.nextRunAt, facts.timeZone)}.` : "";
    const latest = latestRunFor(facts.runs, routine.id);
    const at = latest ? latest.finishedAt ?? latest.startedAt ?? latest.scheduledFor : undefined;
    const lastRun = latest ? ` Last run ${latest.status} at ${time(at!, facts.timeZone)}.` : "";
    lines.push(`${schedulePhrase(routine.schedule, facts.timeZone)}: ${routine.name}.${nextRun}${lastRun}`);
  }
  for (const skill of facts.skills) {
    if (!skill.enabled) continue;
    lines.push(`Knows how to ${lowerFirst(skill.description || skill.name)}.`);
  }
  for (const webhook of facts.webhooks) {
    if (!webhook.enabled) continue;
    lines.push(`Listens for “${webhook.name}” webhooks.`);
  }
  return lines;
}

export async function connectedAppsFacts(
  configured: boolean,
  availability: "configured" | "unconfigured" | "unreadable",
  read: () => Promise<Record<string, { connected: boolean }>>,
): Promise<OverviewFacts["connectedApps"]> {
  let authoritative = availability !== "unreadable";
  let services: string[] = [];
  if (configured && authoritative) {
    try {
      services = Object.entries(await read())
        .filter(([, state]) => state.connected)
        .map(([slug]) => slug);
    } catch {
      authoritative = false;
    }
  }
  return { configured, authoritative, services };
}

function couldUseApps(facts: OverviewFacts): boolean {
  return facts.bot.composio !== false && facts.connectedApps.configured && Boolean(facts.engine?.composioMcp);
}

export function grantsSummary(connectorTools: BotRecord["connectorTools"]): BotOverviewGrant[] | undefined {
  if (connectorTools === undefined) return undefined;
  return Object.entries(connectorTools)
    .map(([slug, grant]): BotOverviewGrant => {
      if (grant.tools === "*") return { slug, level: "all", toolCount: 0 };
      if (grant.tools.length > 0) return { slug, level: "partial", toolCount: grant.tools.length };
      return { slug, level: "none", toolCount: 0 };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

function computerReach(computer: BotRecord["computer"], cloudHome = false): string | null {
  const unavailable = cloudHome ? ", which isn't available on My Cloud" : "";
  switch (computer) {
    case "cloud":
      return "Computer preference: cloud computer.";
    case "vm":
      return `Computer preference: Local VM${unavailable}.`;
    case "local":
      return `Computer preference: this computer${unavailable}.`;
    case "browser":
      return "Computer preference: browser only.";
    case "off":
      return null;
    default:
      return "Computer preference: Auto; availability is checked when a task starts.";
  }
}

function reachesLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  const computer = computerReach(facts.bot.computer, facts.cloudHome);
  if (computer) lines.push(computer);
  lines.push(facts.bot.cwd ? `Works in ${facts.bot.cwd}.` : "Works in its private workspace.");
  const apps = facts.connectedApps;
  if (couldUseApps(facts) && apps.authoritative && apps.services.length > 0) {
    const count = apps.services.length;
    lines.push(`Can use ${count} connected app${count === 1 ? "" : "s"}: ${apps.services.join(", ")}.`);
  } else if (couldUseApps(facts) && !apps.authoritative) {
    lines.push("Connected apps could not be checked.");
  }
  if (facts.browserEnabled && facts.engine?.browserMcp && facts.bot.browser !== false && facts.bot.computer !== "off") lines.push("Has the built-in browser.");
  const peers = facts.sectionPeers;
  if (facts.engine?.agentsMcp && peers > 0 && facts.bot.peers?.length !== 0) {
    lines.push(Array.isArray(facts.bot.peers)
      ? "Talks only to the bots chosen for it."
      : peers === 1 ? "Can talk to the other bot." : `Can talk to all ${peers} other bots, in any department.`);
  }
  if (facts.bot.chiefOfStaff) lines.push("Coordinates its department as Chief of Staff.");
  if (facts.bot.chiefOfStaff && facts.bot.managedSections?.length) {
    lines.push(`Also in charge of these departments: ${facts.bot.managedSections.map(name => name || "General").join(", ")}.`);
  }
  return lines;
}

function wontLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  const mode = approvalModeFor(facts.bot);
  if (mode === "ask") lines.push("Command approvals use Ask mode; saved permissions and provider rules still apply.");
  if (mode === "custom") lines.push("Command approvals follow the provider's custom configuration.");
  if (facts.bot.peers?.length === 0) lines.push("Cannot initiate contact with other bots.");
  else if (mode !== "full" && facts.bot.approvePeerComms) lines.push("Asks before contacting other bots.");
  if (!couldUseApps(facts) || (facts.connectedApps.authoritative && facts.connectedApps.services.length === 0)) {
    lines.push("Has no connected apps.");
  }
  if (facts.bot.computer === "off") lines.push("Can't use a computer.");
  if (!facts.routines.some((routine) => routine.enabled)) lines.push("Won't act on a schedule.");
  if (mode !== "full") lines.push("Profile proposal cards require your approval.");
  return lines;
}

export function buildBotOverview(facts: OverviewFacts): BotOverview {
  return {
    who: {
      name: facts.bot.name,
      title: facts.bot.title,
      blurb: facts.bot.description,
      soulLead: soulLead(facts.bot.soul),
    },
    does: doesLines(facts),
    reaches: reachesLines(facts),
    wont: wontLines(facts),
    recent: facts.recent,
    grants: grantsSummary(facts.bot.connectorTools),
    setup: setupSteps(facts),
  };
}

const DEFAULT_BOT_NAMES = /^(new bot|bot|untitled)(\s*\d+)?$/i;

export function setupSteps(facts: OverviewFacts): SetupStep[] {
  const named = facts.bot.name.trim() !== "" && !DEFAULT_BOT_NAMES.test(facts.bot.name.trim());
  const described = facts.bot.title.trim() !== "" || facts.bot.description.trim() !== "";
  const apps = facts.connectedApps;
  const routines = facts.routines.some((routine) => routine.enabled);
  const webhooks = facts.webhooks.some((webhook) => webhook.enabled);
  const steps: SetupStep[] = [
    { id: "identity", label: "Give it a name and a role", done: named && described, section: "identity" },
    { id: "soul", label: "Write its standing instructions", done: (facts.bot.soul ?? "").trim() !== "", section: "soul" },
    { id: "folder", label: "Choose a working folder", done: Boolean(facts.bot.cwd), section: "access" },
  ];
  if (couldUseApps(facts)) {
    steps.push({
      id: "apps",
      label: "Connect the apps it needs",
      done: apps.authoritative && apps.services.length > 0,
      section: "access",
    });
  }
  steps.push({ id: "schedule", label: "Add a schedule or a trigger", done: routines || webhooks, section: "routines" });
  return steps;
}
