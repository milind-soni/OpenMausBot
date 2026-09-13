import { peerName, renderRoster, reachablePeers, type RosterMember } from "./peer-roster.ts";

export type ChiefTeamMember = RosterMember;

// The Chief's roster stays wider than an ordinary bot's (peer-roster.ts caps
// that one at a dozen): staffing the section is this bot's whole job, so it
// reads the team as a directory rather than as a nudge. The field-level caps
// and the one-line flattening are shared, so the widest roster in the app is
// still the safest place for an imported persona to land.
const ROSTER_MAX_BOTS = 40;

const sectionKey = (section?: string): string => section?.trim() || "";

/** Dynamic system context for a section's Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  trustedOpenMausStatus = "",
  boundedCoordination = false,
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = peerName(chiefSection) || "General";
  // A Chief with its own allow-list is bound by it here too: the roster and
  // the endpoints must agree, or the prompt names teammates the tools will
  // then refuse to reach.
  const team = reachablePeers(bots, chief ?? { id: chiefId, name: "" });
  // `about: true` keeps the blurb the Chief staffs from — and keeps this
  // prompt byte-identical to what Chiefs have always been given. The
  // ordinary-bot roster drops it (peer-roster.ts); widening the Chief's
  // existing exposure was never in scope, and narrowing it here would
  // silently change how a Chief picks a specialist.
  const roster = renderRoster(team, {
    max: ROSTER_MAX_BOTS,
    empty: "- No other visible bots are available yet.",
    about: true,
  });

  const delegation = canDelegate
    ? boundedCoordination
      ? "Use list_bots or list_room_targets for the live reachable roster. Use coordinate_bots to ask actual teammates for advice or assign concrete work. Outside a room, each assignment gets a separate conversation using the recipient's own model and permissions. Busy teammates queue. Give self-contained briefs, then end your turn; you resume automatically after their results return. Leads can coordinate their own specialists. Do not poll, send acknowledgements as new work, or substitute native helpers for named bots. On return, verify the requested outcome, resolve decisions within the user's scope, request concrete corrections with rework=true when necessary, and return one consolidated answer. Consultations are advice, not proof that work or tests ran."
      : [
        "Use list_bots to confirm the live roster and IDs. When assigning work to a teammate, use delegate_bot: it returns immediately, keeps you available to the user, and delivers the teammate's outcome back into this conversation automatically — success or failure. When the result arrives you are woken with it: report it to the user and act. If the teammate fails or stalls, tell the user plainly and decide the next step yourself.",
        "After delegate_bot accepts the task, acknowledge the handoff and continue with any independent work or end your turn. Do not call wait_delegation or repeatedly poll check_delegation in the same turn.",
        "Use ask_bot only for a brief consultation whose answer you must have before writing your current response. Never use ask_bot for an assigned task, background work, or anything potentially long-running.",
        "Delegate with a clear, self-contained brief. Say that the task is assigned, not completed; only claim completion after the teammate's result has actually arrived.",
        "You may assign work to more than one teammate when the request genuinely benefits. Stay responsive while they work, then combine their returned results when the user asks for a synthesis.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    chief?.managedSections?.length
      ? `The owner also allows you to coordinate and propose setup changes for these teams: ${chief.managedSections.map(s => peerName(s) || "General").join(", ")}. You remain the user's single point of contact. This does not grant other bots your access, change their tool permissions, or expose unrelated conversation history. Use list_bots for the actual reachable roster.`
      : "",
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    canDelegate ? "When the user asks you to assemble or configure a team, use list_team_setup for the exact authorized teams, bot IDs and model catalog, then propose_team_setup once with all named specialists and their profile/model changes. Include new teams explicitly; the combined card reviews their creation and your access. Existing thread models stay unchanged. End your turn after the proposal: the user's decision automatically resumes you once with a structured result. Do not ask for another yes, poll, or repeat the proposal. After successful setup, use the available coordination tools for already requested work. Use create_bot only for a single specialist when no combined setup was requested. For explicitly requested bot deletion, use propose_bot_deletion separately. Do not create duplicate or unnecessary bots." : "",
    chief?.managedSections?.length ? "Reachable teammates in your allowed teams:" : `Current ${sectionName} section team:`,
    roster,
    trustedOpenMausStatus,
  ].filter(Boolean).join("\n");
}
