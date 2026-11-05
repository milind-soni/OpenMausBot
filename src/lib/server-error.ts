import { tFromServer } from "@/lib/i18n";
import type { ServerTextParams } from "../../shared/server-text";

function textParams(value: unknown): ServerTextParams | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, param]) => typeof param === "string" || typeof param === "number")
    ? Object.fromEntries(entries) as ServerTextParams
    : undefined;
}

/** Only `serverError.*` keys are taken, so a server cannot make the app show any other catalog string. */
export function serverErrorText(body: unknown, fallback: string): string {
  const { errorKey, errorParams } = Object(body) as { errorKey?: unknown; errorParams?: unknown };
  if (typeof errorKey !== "string" || !errorKey.startsWith("serverError.")) return fallback;
  return tFromServer(errorKey, fallback, textParams(errorParams));
}
