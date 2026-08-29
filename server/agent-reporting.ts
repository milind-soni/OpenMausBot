import type { BotReportingMode } from "../shared/bot-profile.ts";

/** One prompt seam for a user-owned reporting preference. The policy affects
 * unsolicited operational updates only; it never suppresses direct answers
 * or an approval that is required to proceed. */
export function reportingSystemPrompt(mode: BotReportingMode | undefined): string {
  switch (mode ?? "all") {
    case "all":
      return "";
    case "actionable":
      return "\nUpdate policy: keep background work quiet. Do not surface successful checks, freshness heartbeats, retry progress, cleared alerts, or reminders that a monitor ran or will run. Surface only a new action for the user, a material result, a genuine failure or authentication problem needing attention, or status the user explicitly requested. Keep routine evidence in receipts instead of narrating it.";
    case "silent":
      return "\nUpdate policy: do not proactively surface background, routine, or peer-agent updates. Reply normally when the user addresses you, and interrupt only for an approval that is required to continue safely.";
  }
}

/** Scheduled work already has durable receipts. Only the verbose mode turns a
 * normal successful routine into a push notification; failures and approval
 * gates use their own notification kinds and remain visible. */
export function notifyRoutineCompletion(mode: BotReportingMode | undefined): boolean {
  return (mode ?? "all") === "all";
}
