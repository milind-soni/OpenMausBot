import { redactParams } from "../shared/redact.ts";
import { formatServerText, type ServerErrorBody, type ServerTextParams } from "../shared/server-text.ts";

/** The client translates by key and falls back to this English, which the server keeps sending for older clients. */
export const USER_ERROR = {
  "serverError.pair.codeWrong": "pairing code is wrong or has expired; create a new one on the server",
  "serverError.pair.tooMany": "too many failed pairing attempts from your address; try again in {seconds}s",
  "serverError.pair.linkExpired": "this sign-in link has expired or was already used",
  "serverError.email.invalid": "enter a valid email address",
  "serverError.email.codeFormat": "enter the 8-digit code from the email",
  "serverError.email.tooMany": "too many attempts; wait a minute and request a new code",
  "serverError.email.codeWrong": "that code is wrong or has expired; request a new one",
  "serverError.email.notAllowed": "this email is not on this server's sign-in list; ask the server's owner to add it",
  "serverError.email.unavailable": "the sign-in service could not be reached ({detail}); try again in a moment",
  "serverError.email.notSetUp": "email sign-in is not set up on this server; use a pairing code",
  "serverError.signIn.tooMany": "too many failed sign-in attempts from your address; try again in {seconds}s",
  "serverError.cloud.personal": "My Cloud is personal: only your own devices can connect.",
  "serverError.model.botBusy": "the bot is working — stop it before changing models",
  "serverError.model.accountUpdating": "this provider account is being updated — try again shortly",
  "serverError.chat.busyEdit": "the thread is working — stop it before editing",
  "serverError.chat.busyVersion": "the thread is working — stop it before switching versions",
  "serverError.chat.questionGone": "this question is no longer available",
  "serverError.chat.askerGone": "the bot that asked this question is no longer available",
  "serverError.chat.routineElsewhere": "this bot is running a routine in another conversation",
  "serverError.chat.busyInRoom": "this bot is working in channel {room}",
  "serverError.chat.answerSent": "That answer is already on its way.",
  "serverError.chat.savingCredential": "this task is securely saving a credential — try again when it finishes",
  "serverError.team.personalMove": "Moving a computer's bots, chats and logins goes to My Cloud only. Nothing personal comes into {team}.",
  "serverError.team.memberLogin": "On {team} only an admin can save a login, and it is then used by every bot in {team}.",
  "serverError.team.signInFirst": "Sign in to {team} in the app first.",
  "serverError.chat.ownerOrAdmin": "Only the owner or an admin can do that.",
  "serverError.routine.checks": "Choose checks from calendar, mail and runs",
  "serverError.routine.checksRepeat": "Checks need a bot routine that repeats",
  "serverError.routine.access": "Choose read-and-draft access or none",
  "serverError.routine.deliver": "Only a bot routine can deliver to the brief",
  "serverError.team.noSuchPhone": "no such phone",
  "serverError.team.sessionEnded": "Your session ended. Sign in again before creating a pairing code.",
  "serverError.page.roomOrClosed": "Pages from a room or a closed conversation can't be published here.",
  "serverError.page.notHere": "That page is not in this conversation.",
  "serverError.page.fromMcp": "That app came from an MCP server; only a page a bot made can be published.",
  "serverError.page.versionGone": "That version of the page is no longer kept.",
  "serverError.page.notStored": "This app's page is not stored on this computer.",
  "serverError.department.notFound": "No such department",
  "serverError.department.missing": "no such department",
  "serverError.department.nameLength": "Department name must be 1 to 60 characters",
  "serverError.department.nameRule": "Department name must be 1 to 60 characters without control characters",
  "serverError.department.unassignComputer": "Unassign this department's computer before deleting the department",
  "serverError.department.oneChief": "A department can have only one Chief of Staff. Choose one Chief or use a department without one.",
  "serverError.department.memoryChanged": "This department memory changed. Reload it before saving or approving.",
  "serverError.department.shareTooLarge": "This department is too large to share (4 MB). Leave out pictures, starter notes or some skills and try again.",
  "serverError.department.shareSkillClash": "Two bots in this department have different skills named \"{skill}\". Leave that skill out and try again.",
  "serverError.department.shareNoBots": "Add a bot to this department before sharing it.",
  "serverError.department.shareSkillLimit": "A department can share at most {count} skills. Choose fewer skills and try again.",
  "serverError.department.shareBotSkillLimit": "{name} has more than {count} skills. Choose fewer skills and try again.",
  "serverError.department.createFirst": "Create the named department before making a Chief responsible for it",
  "serverError.department.chiefOnlyExtra": "Only a Chief may manage existing additional departments",
  "serverError.department.confirmExtra": "Confirm additional department access (acknowledgePeerScope)",
  "serverError.department.stopBots": "Stop running bots before granting access to another department, or use the desktop app or a paired Full-access session.",
  "serverError.share.version": "Use a version like 1.2.3.",
  "serverError.preset.empty": "Your New bot defaults are empty. Give them a name, instructions, skills or starter notes first.",
  "serverError.preset.tooLarge": "This preset is too large to share (4 MB). Leave out starter notes or some skills and try again.",
} as const;

export type UserErrorKey = keyof typeof USER_ERROR;

export type UserError = { error: string; errorKey: UserErrorKey; errorParams?: ServerTextParams };

/** Security invariant: params are scrubbed like the English they fill, so a secret survives in neither. */
export function userError(key: UserErrorKey, params?: ServerTextParams): UserError {
  const safe = params && redactParams(params);
  return { error: formatServerText(USER_ERROR[key], safe), errorKey: key, ...(safe ? { errorParams: safe } : {}) };
}

export function userErrorThrown(key: UserErrorKey, params?: ServerTextParams): Error {
  const { error, ...fields } = userError(key, params);
  return Object.assign(new Error(error), fields);
}

export function userErrorFields(value: unknown): Pick<ServerErrorBody, "errorKey" | "errorParams"> {
  const { errorKey, errorParams } = Object(value) as { errorKey?: unknown; errorParams?: unknown };
  if (typeof errorKey !== "string" || !Object.hasOwn(USER_ERROR, errorKey)) return {};
  const params = errorParams && typeof errorParams === "object" && !Array.isArray(errorParams)
    ? redactParams(errorParams as ServerTextParams) : undefined;
  return { errorKey, ...(params ? { errorParams: params } : {}) };
}

export function refusalBody(refusal: { error: string; errorKey?: string; errorParams?: ServerTextParams }): ServerErrorBody {
  return { error: refusal.error, ...userErrorFields(refusal) };
}
