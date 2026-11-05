import { redactParams, redactSecretsInText } from "../shared/redact.ts";
import { formatServerText, isReferenceParam, type ServerText, type ServerTextParams } from "../shared/server-text.ts";
import { CHAT_NOTICE } from "./chat-notices.ts";
import type { RoutineCheckResult } from "./routines.ts";

/** The client words each line by key and falls back to this English, which the server keeps storing for older clients. */
export const ROUTINE_LINE = {
  "routines.server.checksFailed": "The checks could not run; they try again at the next check.",
  "routines.server.nothingNew": "Nothing new since the last check",
  "routines.server.limitWait": "Waiting for the AI's usage limit to reset; this run starts again at {resets}",
  "routines.server.retryAfter": "Starting again shortly after {why}: {failure}",
  "routines.server.retryAfterRestart": "Starting again shortly after OpenMausBot restarted while it ran",
  "routines.server.backupAi": "Starting again on the backup AI: this bot's AI reached its usage limit",
  "routines.server.waitingToStart": "Waiting to start: {failure}",
  "routines.server.stillBusy": "Did not start: still busy after {minutes} minutes ({failure})",
  "routines.server.failedAfterRetry": "Failed after one automatic retry: {failure}",
  "routines.server.signedOut": "This bot's AI is signed out. Sign in again in Settings → AI. The AI said: “{failure}”",
  "routines.server.part.stalled": "the AI stalled",
  "routines.server.part.rateLimited": "a rate limit",
  "routines.server.part.provider": "a temporary error",
  "routines.server.part.failed": "a failure",
  "routines.server.backupSignedOut": "Starting again on the backup AI: this bot's AI is signed out",
} as const;

export type RoutineLineKey = keyof typeof ROUTINE_LINE;

export const RUN_LINE_MAX = 500;

export interface RoutineTroubleCode {
  checkTroubleCode?: string;
}

/** Catalog keys and params beside a run's fixed lines. A client words one only while its field still reads as that
 * line's English. */
export interface RoutineLineCodes {
  outputCode?: string;
  errorCode?: string;
  errorParams?: ServerTextParams;
  attentionCode?: string;
  attentionParams?: ServerTextParams;
}

const template = (key: string): string | undefined =>
  Object.hasOwn(ROUTINE_LINE, key) ? ROUTINE_LINE[key as RoutineLineKey] : Object.hasOwn(CHAT_NOTICE, key) ? CHAT_NOTICE[key as keyof typeof CHAT_NOTICE] : undefined;

function composed(key: string, params?: ServerTextParams): string | undefined {
  const line = template(key);
  if (line === undefined) return undefined;
  const words = params && Object.fromEntries(Object.entries(params).map(([name, value]) => [name, isReferenceParam(name, value) ? template(String(value)) ?? value : value]));
  return formatServerText(line, words);
}

export function routineLine(key: RoutineLineKey, params?: ServerTextParams): string {
  return composed(key, params)!;
}

export type RoutineLine = { text: string; codes: RoutineLineCodes };

/** The code is kept only when its params rebuild the stored text byte for byte. */
export function fittedLine(field: "error" | "attention", english: string, text: ServerText | undefined): RoutineLine {
  const full = redactSecretsInText(english), stored = full.slice(0, RUN_LINE_MAX);
  const none: RoutineLine = { text: stored, codes: { [`${field}Code`]: undefined, [`${field}Params`]: undefined } };
  if (!text || template(text.key) === undefined) return none;
  let params = text.params && redactParams(text.params);
  const last = /\{(\w+)\}$/.exec(template(text.key)!)?.[1];
  const value = last ? params?.[last] : undefined;
  if (stored !== full && last && typeof value === "string" && !isReferenceParam(last, value)) {
    params = { ...params, [last]: value.slice(0, Math.max(0, value.length - (full.length - stored.length))) };
  }
  if (composed(text.key, params) !== stored) return none;
  return { text: stored, codes: { [`${field}Code`]: text.key, [`${field}Params`]: params } };
}

export function codedLine(field: "error" | "attention", key: RoutineLineKey, params?: ServerTextParams): RoutineLine {
  const safe = params && redactParams(params);
  return fittedLine(field, routineLine(key, safe), { key, ...(safe ? { params: safe } : {}) });
}

export function runLineFields(field: "error" | "attention", english: string, text: ServerText | undefined): Partial<Record<"error" | "attention", string>> & RoutineLineCodes {
  const line = fittedLine(field, english, text);
  return { ...line.codes, [field]: line.text };
}

export function applyCheckResult(routine: RoutineTroubleCode & { checkTrouble?: string; wakeAt?: number; checkedAt?: number }, result: RoutineCheckResult, now: number): void {
  for (const field of ["wakeAt", "checkTrouble", "checkTroubleCode"] as const) delete routine[field];
  Object.assign(routine, result.wakeAt === undefined ? {} : { wakeAt: result.wakeAt },
    result.trouble ? { checkTrouble: result.trouble.slice(0, 300), ...(result.troubleCode ? { checkTroubleCode: result.troubleCode } : {}) } : {},
    result.trouble || result.run ? {} : { checkedAt: now });
}
