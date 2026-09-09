import { renderRoster, reachablePeers, type RosterMember } from "./peer-roster.ts";

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
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
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
    ? [
        "Use list_bots to confirm the live roster and IDs. When assigning work to a teammate, use delegate_bot: it returns immediately, keeps you available to the user, and delivers the teammate's outcome back into this conversation automatically — success or failure. When the result arrives you are woken with it: report it to the user and act. If the teammate fails or stalls, tell the user plainly and decide the next step yourself.",
        "After delegate_bot accepts the task, acknowledge the handoff and continue with any independent work or end your turn. Do not call wait_delegation or repeatedly poll check_delegation in the same turn.",
        "Use ask_bot only for a brief consultation whose answer you must have before writing your current response. Never use ask_bot for an assigned task, background work, or anything potentially long-running.",
        "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots.",
        "Delegate with a clear, self-contained brief. Say that the task is assigned, not completed; only claim completion after the teammate's result has actually arrived.",
        "You may assign work to more than one teammate when the request genuinely benefits. Stay responsive while they work, then combine their returned results when the user asks for a synthesis.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    `Current ${sectionName} section team:`,
    roster,
    trustedOpenMausStatus,
  ].filter(Boolean).join("\n");
}
