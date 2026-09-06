// One builder for "what does this bot do" plain-language sentences, so the
// phones (step 5) and the web settings dialog agree on the same wording. The
// route in index.ts (botOverview()) is the only place that reads server-only
// state (engine capabilities, connected-apps inventory, history); everything
// here is pure and takes that state already gathered as OverviewFacts.
import type { BotRecord } from "./store.ts";
import type { Routine } from "./routines.ts";
import type { RoutineRequestSchedule } from "../shared/routine-request.ts";
import { approvalModeFor } from "../shared/approval-mode.ts";

export interface BotOverview {
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
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
    | "browser"
    | "chiefOfStaff"
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
  connectedApps: { configured: boolean; authoritative: boolean; services: string[] };
  sectionPeers: number;
  timeZone: string;
  recent: Array<{ at: number; summary: string }>;
}

/** The first paragraph of a SOUL.md-style persona, capped at 240 characters
 * so a settings-dialog card never renders a full standing-instructions
 * document inline. */
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

/** "09:05" → "9:05 AM" — the daily schedule's wall-clock time as a person
 * would say it, with no timezone suffix (the Overview is read in the
 * timezone it was built for). */
function clockTime(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map((part) => Number.parseInt(part, 10) || 0);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** The schedule as the opening phrase of a Does line — "Every 5 minutes",
 * "Every weekday at 9:00 AM", "Once on September 5 at 12:00 PM". The
 * approval card's scheduleText() carries the anchor instant and timezone
 * name because a card must be exact; a plain-language overview must not. */
function schedulePhrase(schedule: OverviewFacts["routines"][number]["schedule"], timeZone: string): string {
  if (schedule.type === "once") {
    const date = new Date(schedule.at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone });
    return `Once on ${date} at ${time(schedule.at, timeZone)}`;
  }
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

/** The most recent run for a routine, by (finishedAt ?? startedAt ??
 * scheduledFor) — not merely the first match in `runs`, since callers may
 * hand this an unsorted or multi-routine list. */
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

/** The connected-apps facts for the route: reads the inventory only when a
 * connector is configured and the credential store was readable, and treats
 * a failing read (connector down, token rejected) as "unverified" rather
 * than letting it fail the whole Overview. `read` is injected so the
 * fallback is unit-testable without a live connector. */
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

/** Whether this bot could use connected apps at all: apps on for the bot,
 * a connector configured, and an engine that mounts the Composio MCP. */
function couldUseApps(facts: OverviewFacts): boolean {
  return facts.bot.composio !== false && facts.connectedApps.configured && Boolean(facts.engine?.composioMcp);
}

function computerReach(computer: BotRecord["computer"]): string | null {
  switch (computer) {
    case "cloud":
      return "Computer preference: cloud computer.";
    case "vm":
      return "Computer preference: Local VM.";
    case "local":
      return "Computer preference: this computer.";
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
  const computer = computerReach(facts.bot.computer);
  if (computer) lines.push(computer);
  lines.push(facts.bot.cwd ? `Works in ${facts.bot.cwd}.` : "Works in its private workspace.");
  const apps = facts.connectedApps;
  // Only a bot that could actually use apps gets an apps line here. When it
  // could, the inventory decides: verified and non-empty → list them;
  // unverified → say so rather than guess either way.
  if (couldUseApps(facts) && apps.authoritative && apps.services.length > 0) {
    const count = apps.services.length;
    lines.push(`Can use ${count} connected app${count === 1 ? "" : "s"}: ${apps.services.join(", ")}.`);
  } else if (couldUseApps(facts) && !apps.authoritative) {
    lines.push("Connected apps could not be checked.");
  }
  if (facts.browserEnabled && facts.engine?.browserMcp && facts.bot.browser !== false && facts.bot.computer !== "off") lines.push("Has the built-in browser.");
  if (facts.engine?.agentsMcp && facts.sectionPeers > 0 && facts.bot.peers?.length !== 0) {
    lines.push(`Can talk to ${facts.sectionPeers} other bot${facts.sectionPeers === 1 ? "" : "s"} in its section.`);
  }
  if (facts.bot.chiefOfStaff) lines.push("Coordinates its section as Chief of Staff.");
  return lines;
}

function wontLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  const mode = approvalModeFor(facts.bot);
  if (mode === "ask") lines.push("Command approvals use Ask mode; saved permissions and provider rules still apply.");
  if (mode === "custom") lines.push("Command approvals follow the provider's custom configuration.");
  if (facts.bot.peers?.length === 0) lines.push("Cannot initiate contact with other bots.");
  else if (facts.bot.approvePeerComms) lines.push("Asks before contacting other bots.");
  // "Has no connected apps." is definite when apps are off for this bot,
  // not configured, or unsupported by its engine — no inventory needed. Only
  // the "configured but nothing connected" case rests on the inventory, so
  // only that case requires it to be authoritative.
  if (!couldUseApps(facts) || (facts.connectedApps.authoritative && facts.connectedApps.services.length === 0)) {
    lines.push("Has no connected apps.");
  }
  if (facts.bot.computer === "off") lines.push("Can't use a computer.");
  if (!facts.routines.some((routine) => routine.enabled)) lines.push("Won't act on a schedule.");
  lines.push("Profile proposal cards require your approval.");
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
  };
}
