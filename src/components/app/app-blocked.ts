import type { AppBlockedReason } from "../../../shared/app";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const BLOCKED_KEY: Record<AppBlockedReason, LocaleKey> = {
  "signed-out": "app.blocked.signedOut",
  "server-removed": "app.blocked.serverRemoved",
  "server-disabled": "app.blocked.serverDisabled",
  "apps-off": "app.blocked.appsOff",
  "too-large": "app.blocked.tooLarge",
  unavailable: "app.blocked.unavailable",
};

export function appBlockedLine(reason: AppBlockedReason, server?: string, sent?: string): string {
  if (!Object.hasOwn(BLOCKED_KEY, reason)) return sent ?? "";
  return t(BLOCKED_KEY[reason], { server: server?.trim() || t("app.blocked.thisServer") });
}
