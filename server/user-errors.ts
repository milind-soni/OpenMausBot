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
} as const;

export type UserErrorKey = keyof typeof USER_ERROR;

export type UserError = { error: string; errorKey: UserErrorKey; errorParams?: ServerTextParams };

export function userError(key: UserErrorKey, params?: ServerTextParams): UserError {
  return { error: formatServerText(USER_ERROR[key], params), errorKey: key, ...(params ? { errorParams: params } : {}) };
}

export function userErrorFields(value: unknown): Pick<ServerErrorBody, "errorKey" | "errorParams"> {
  const { errorKey, errorParams } = Object(value) as { errorKey?: unknown; errorParams?: unknown };
  if (typeof errorKey !== "string" || !Object.hasOwn(USER_ERROR, errorKey)) return {};
  const params = errorParams && typeof errorParams === "object" && !Array.isArray(errorParams)
    ? errorParams as ServerTextParams : undefined;
  return { errorKey, ...(params ? { errorParams: params } : {}) };
}

export function refusalBody(refusal: { error: string; errorKey?: string; errorParams?: ServerTextParams }): ServerErrorBody {
  return { error: refusal.error, ...userErrorFields(refusal) };
}
