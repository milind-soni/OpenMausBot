// A turn that ends with a card still open parks until the person answers it: which cards park a turn, and the line
// that resumes it once they have.
import { bugReportOutcome, bugReportResumePrompt } from "../shared/bug-report.ts";
import { signInOutcome, signInResumePrompt } from "../shared/sign-in-request.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import type { Message } from "./store.ts";

export const teamSetupDecisionText = (request: TeamSetupRequest): string => {
  const notNow = request.suggestion && request.result?.state === "denied"
    ? " The user chose Not now for this suggested specialist. Do not suggest another specialist in this conversation unless they ask for one." : "";
  return `OpenMausBot team setup decision ${request.requestId}: ${JSON.stringify(request.result)}. Report this exact result and continue the user's already requested work. Do not ask for confirmation again or repeat this setup/deletion. A denied or cancelled operation did not authorize any substitute action. Existing thread models were not changed.${notNow}`;
};
export const connectionUpdateText = (labels: readonly string[]): string =>
  `OpenMausBot connection update: the user securely connected ${labels.join(", ")}. Continue the task that paused for this connection. Do not ask them to connect it again.`;
export const credentialUpdateText = (label: string, outcome: "provided" | "dismissed"): string => outcome === "provided"
  ? `OpenMausBot credential update: the user securely provided ${label}. Continue the task that paused for it. You do not receive the secret and must not ask them to paste it into chat.`
  : `OpenMausBot credential update: the user declined to provide ${label}. Continue without it if possible, or briefly explain the limitation. Do not ask them to paste it into chat.`;

export function openCardWaits(rows: readonly Message[]): Array<{ id: string; waits: string }> {
  const open: Array<{ id: string; waits: string }> = [];
  for (const message of rows) {
    const card = message.card;
    if (card?.teamSetupRequest && !card.teamSetupRequest.resumed && (card.teamSetupRequest.result || (!card.answered && !card.dismissed && !card.expired))) {
      open.push({ id: message.id, waits: `team setup decision: ${card.title}` });
      continue;
    }
    const connector = message.connector;
    if (connector && !connector.dismissed && !connector.resumed) {
      open.push({ id: message.id, waits: `connect ${connector.label}` });
      continue;
    }
    const secret = message.secret;
    if (secret && !secret.resumed && !secret.superseded) {
      open.push({ id: message.id, waits: `provide ${secret.label}` });
      continue;
    }
    const signIn = message.signIn;
    if (signIn && !signIn.resumed && !signIn.superseded) {
      open.push({ id: message.id, waits: `sign in to ${signIn.site}` });
      continue;
    }
    const report = message.bugReport;
    if (report && !report.resumed && !report.superseded) open.push({ id: message.id, waits: "review a bug report draft" });
  }
  return open;
}

/** A credential, sign-in or bug report card already answered: the line for its parked turn, and the patch that marks
 * the card resumed (null when it already is). */
export function answeredCardResume(message: Message): { text: string; patch: Partial<Message> | null } | null {
  const secret = message.secret;
  if (secret && !secret.superseded && (secret.provided || secret.dismissed)) {
    return {
      text: credentialUpdateText(secret.label, secret.provided ? "provided" : "dismissed"),
      patch: secret.resumed ? null : { secret: { ...secret, resumed: true, error: undefined } },
    };
  }
  const signIn = message.signIn;
  const signedIn = signIn && !signIn.superseded ? signInOutcome(signIn) : null;
  if (signIn && signedIn) {
    return {
      text: signInResumePrompt(signIn.site, signedIn),
      patch: signIn.resumed ? null : { signIn: { ...signIn, resumed: true, error: undefined } },
    };
  }
  const report = message.bugReport;
  const reported = report && !report.superseded ? bugReportOutcome(report) : null;
  if (report && reported) {
    return { text: bugReportResumePrompt(reported, report.reportId), patch: report.resumed ? null : { bugReport: { ...report, resumed: true } } };
  }
  return null;
}

/** Stop ended the turn this card paused. */
export function stoppedCardPatch(message: Message): Partial<Message> | null {
  if (message.secret) return { secret: { ...message.secret, stopped: true } };
  if (message.connector) return { connector: { ...message.connector, stopped: true } };
  if (message.signIn) return { signIn: { ...message.signIn, stopped: true } };
  if (message.bugReport) return { bugReport: { ...message.bugReport, stopped: true } };
  return null;
}
