import { formatTime } from "@/lib/clock-time";
import { tFromServer } from "@/lib/i18n";
import type { ServerTextParams } from "../../shared/server-text";

function textParams(value: unknown): ServerTextParams | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, param]) => typeof param === "string" || typeof param === "number")) return undefined;
  const params = Object.fromEntries(entries) as ServerTextParams;
  // `until` is a moment the server names; `time` is that moment on this device's clock.
  if (typeof params.until === "number") params.time = formatTime(params.until);
  return params;
}

/** Only `serverError.*` keys are taken, so a server cannot make the app show any other catalog string. */
export function serverErrorText(body: unknown, fallback: string): string {
  const { errorKey, errorParams } = Object(body) as { errorKey?: unknown; errorParams?: unknown };
  if (typeof errorKey !== "string" || !errorKey.startsWith("serverError.")) return fallback;
  return tFromServer(errorKey, fallback, textParams(errorParams));
}
