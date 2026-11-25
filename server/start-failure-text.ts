import type { ServerText } from "../shared/server-text.ts";
import { userErrorFields } from "./user-errors.ts";

const START_FAILURE = {
  "serverError.computer.desktopOnly": "chat.notice.computerDesktopOnly",
  "serverError.computer.permissionsThenRestart": "chat.notice.computerPermissionsThenRestart",
  "serverError.computer.notReadyDetail": "chat.notice.computerNotReadyDetail",
  "serverError.computer.notReadyMacPermission": "chat.notice.computerNotReadyMacPermission",
  "serverError.computer.systemUnsupported": "chat.notice.computerSystemUnsupported",
  "serverError.computer.aiUnsupported": "chat.notice.computerAiUnsupported",
  "serverError.engine.signedOut": "chat.notice.engineSignedOut",
} as const;

export function startFailureText(error: unknown): ServerText | undefined {
  const fields = userErrorFields(error);
  if (!fields.errorKey || !Object.hasOwn(START_FAILURE, fields.errorKey)) return undefined;
  return { key: START_FAILURE[fields.errorKey as keyof typeof START_FAILURE], ...(fields.errorParams ? { params: fields.errorParams } : {}) };
}
