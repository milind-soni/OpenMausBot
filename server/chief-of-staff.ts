import { botOwner, nameFromEmail } from "../shared/bot-owner.ts";
import { canManage, hasAuthority, inChargeOfEvery, linkedLayout, peerName, renderRoster, reachablePeers, type RosterMember, type TeamPrompt } from "./peer-roster.ts"; import { chiefLevel } from "./chief-level.ts";
import type { TaskRecord } from "./store.ts"; import type { LinkedChiefView } from "./host/linked-roster.ts";

export type ChiefTeamMember = RosterMember;

/** A thread one teammate opened on another: a Chief may fold it only when it manages both. */
export function chiefTidies(
  from: RosterMember,
  task: Pick<TaskRecord, "openedBy" | "routineRunId">,
  opener: RosterMember | null | undefined,
  owner: RosterMember,
): boolean {
  return chiefLevel(from) && Boolean(task.openedBy) && !task.routineRunId &&
    opener != null && canManage(from, opener) && canManage(from, owner);
}

const ROSTER_MAX_BOTS = 40;
const OTHERS_MIN_BOTS = 8;

const SPECIALISTS = "When a job needs a specialist you do not have (an ongoing area of work, a different skill set, or work to run in parallel), add one with create_bot without asking first, then tell the person in one line; they can undo it. When their goal matches a ready-made team, list_team_library has its roles to create the same way. Never add a bot just to look busy, or one that duplicates a teammate.";

const sectionKey = (section?: string): string => section?.trim() || "";

/** Names the team every turn; who is busy changes turn to turn, so it rides the volatile half instead. */
/** The Team map sends an @everyone line to the Chief alone (src/lib/map-composer.ts): every bot taking a turn of its own cost
 * a fan-out of 13 bots about 13 model turns, most of them from bots the line did not concern. */
export const EVERYONE_ON_THE_MAP = "When the person writes to @everyone on the Team map, it comes to you alone, so you decide who it concerns: hand it with coordinate_bots to the teammates whose work it touches, never to all of them by default, and do the part that is yours. If it concerns nobody else, answer it yourself.";

export function chiefOfStaffSystemPrompt(...args: Parameters<typeof chiefOfStaffPrompt>): string {
  const { rules, roster } = chiefOfStaffPrompt(...args);
  return `${rules}\n${roster}`;
}

export function chiefOfStaffPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  also?: (bot: ChiefTeamMember) => boolean,
  departments?: readonly string[],
  /** The person's other place, while it is linked (server/host/linked-roster.ts). */
  linked?: LinkedChiefView,
): TeamPrompt {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = peerName(chiefSection) || "General";
  const owner = chief ? botOwner(chief) : null;
  const person = owner ? peerName(nameFromEmail(owner)) || "your person" : null;
  const reachable = reachablePeers(bots, chief ?? { id: chiefId, name: "" }, also);
  const team = chief ? reachable.filter((bot) => hasAuthority(chief, bot)) : reachable;
  const others = chief ? reachable.filter((bot) => !hasAuthority(chief, bot)) : [];
  // Linked: every bot of both places, one rule for every bot (peer-roster.ts `linkedLayout`).
  const layout = linked?.far ? linkedLayout([...team, ...others], linked.far) : undefined;
  const teamMax = layout ? Math.min(team.length, layout.max) : ROSTER_MAX_BOTS;
  const othersMax = Math.max(ROSTER_MAX_BOTS - team.length, OTHERS_MIN_BOTS);
  // The lines named with the link off stay exactly as they are; only those past them are names alone.
  const compact = (full: number) => (layout ? { compact: layout.compact, full, keepId: layout.keepId } : {});
  const roster = renderRoster(team, {
    max: teamMax,
    empty: "- No other visible bots are available yet.",
    about: true,
    department: chiefSection,
    ...compact(ROSTER_MAX_BOTS),
  });
  const othersRoster = others.length ? renderRoster(others, {
    max: layout ? layout.max - teamMax : othersMax,
    empty: "",
    about: false,
    department: chiefSection,
    ...compact(othersMax),
  }) : "";

  const delegation = canDelegate
    ? "Use list_bots or list_room_targets for the live reachable roster. Use coordinate_bots to assign actual teammates concrete work, or with consult: true to ask them for advice; it returns at once and keeps you available to the user: give a clear, self-contained brief, then end your turn, and you resume automatically when their results return, success or failure. Say that work is assigned, not completed; only claim completion after the teammate's result has actually arrived, and if a teammate fails or stalls, tell the user plainly and decide the next step yourself. Leads can coordinate their own specialists. Do not poll or wait, send acknowledgements as new work, or substitute native helpers for named bots. On return, verify the requested outcome, resolve decisions within the user's scope, ask for concrete corrections with rework=true when needed, and return one consolidated answer. Consultations are advice, not proof that work or tests ran. A refusal from coordinate_bots means nothing was sent: fix what it names (usually the id: copy it from list_bots or your roster, or use a unique teammate name) and retry; never describe a handoff the tool did not accept."
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  const isChief = !chief?.defaultBot || chief.chiefOfStaff === true;
  const everywhere = Boolean(chief && departments && inChargeOfEvery(chief, departments));
  const responsibleFor = everywhere ? "every department, and each new department becomes yours as it is added"
    : chief?.managedSections?.length ? `these departments: ${chief.managedSections.map(s => peerName(s) || "General").join(", ")}` : "";
  const farChief = isChief && !person ? linked?.chief : undefined;
  const rules = [
    farChief
      ? `You are the person's assistant and look after their bots in this place, but you are not their Chief of Staff: the Chief ${farChief.where} (id ${farChief.id}) is their Chief and one point of contact. Never present yourself as their Chief${canDelegate ? "; for anything about their whole team, bring that Chief in with coordinate_bots and its id" : ""}.`
      : isChief
      ? person
        ? `You are ${person}'s assistant and Chief of Staff: their one point of contact. The bots that report to ${person}, in every department, are your team: you direct their work, and their incidents come to you.`
        : `You are the person's assistant and the Chief of Staff for the ${sectionName} department: their one point of contact.`
      : chief?.defaultBot?.person
        ? `You hold a Chief of Staff's tools for the ${sectionName} department, but you are not the Chief: the daily brief and team incidents stay with the Chief.`
        : `You hold a Chief of Staff's tools for the ${sectionName} department, but you are not the Chief: team incidents stay with the Chief. Keeping an eye on the person's day and their daily brief are yours.`,
    responsibleFor
      ? `The owner also made you responsible for ${responsibleFor}. You supervise their bots and may propose setup changes there. You remain the user's single point of contact. This does not grant other bots your access, change their tool permissions, or expose unrelated conversation history.`
      : "",
    canDelegate && `Every other bot on this team, in any department, is reachable too: consult it or hand it work with coordinate_bots whenever a job needs it, without asking anyone to set anything up. Reaching a bot${responsibleFor || person ? " outside your team" : ""} gives you no authority over it: its setup, its threads and its incidents stay with its own Chief, so ask rather than direct.`,
    "Do the work yourself, bring in a teammate when one fits the job, and return one concise consolidated answer. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    canDelegate && "A standing preference the person states for all their bots (where reminders go, how replies should sound) is one line you save yourself with memory_update action prefer: every bot reads it. Never send it to each bot with coordinate_bots.",
    canDelegate ? SPECIALISTS : "",
    canDelegate && isChief ? EVERYONE_ON_THE_MAP : "",
    canDelegate && isChief
      ? "Incidents: when a teammate's run fails, stalls or cannot start, OpenMausBot reports it to you in your \"Problems to look at\" thread with a link to the thread. Read the report, then either call retry_thread to resume that thread where it stopped, coordinate_bots with a corrected brief when the request itself must change, or — when only the person can fix the cause (a sign-in, a missing credential, an unanswered question, a setting) — say so plainly and stop. Never retry the same thread more than twice; report what failed and what you did in one or two sentences."
      : "",
    delegation,
    canDelegate ? "Housekeeping: list_threads also shows threads one teammate opened on another (marked \"opened by\"), and you may close_thread those once they are idle and their work is done. Threads the person started are theirs: never close them." : "",
    canDelegate ? "When the user asks you to assemble or configure a team, get the exact authorized teams, bot IDs and model catalog from list_team_setup, then call propose_team_setup once with all named specialists and their profile/model changes, new teams included: the plan covers their creation and your access. Existing thread models and other bots' execution permissions stay unchanged. The plan applies immediately at every access level and the person can undo it; after an applied result, continue already-requested work without another confirmation, using the coordination tools. Only if review is pending, end your turn: the user's decision resumes you once with a structured result. Report failed or cancelled results honestly; never ask for another yes, poll or repeat the proposal. For explicitly requested bot deletion, use propose_bot_deletion separately and follow its applied or pending result too." : "",
  ].filter(Boolean).join("\n");
  const listed = [
    person ? `Bots that report to ${person} (your team):` : everywhere ? "Your team, in every department:" : chief?.managedSections?.length ? "Your team, in the departments you are responsible for:" : `Current ${sectionName} department (your team):`,
    roster,
    othersRoster && (person ? "Other bots you can reach (they report to someone else):" : "Other bots you can reach, in other departments:"),
    othersRoster,
    layout ? layout.far : linked?.roster,
  ].filter(Boolean).join("\n");
  return { rules, roster: listed };
}
