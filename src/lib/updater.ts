import { useEffect, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { en, type LocaleKey } from "@/locales";
import type { UpdaterState } from "@/types/ogb";

export type { UpdaterState };

export function useUpdaterState(): UpdaterState | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => window.ogb?.updater?.onState(setState), []);
  return window.ogb?.updater ? state : null;
}

const UPDATE_TEXT: Record<NonNullable<UpdaterState["messageCode"]>, LocaleKey> = {
  tls: "update.error.tls",
  integrity: "update.error.integrity",
  disk: "update.error.disk",
  permission: "update.error.permission",
  busy: "update.error.busy",
  feed: "update.error.feed",
  network: "update.error.network",
  prepareTimeout: "update.error.prepareTimeout",
  slowRestart: "update.error.slowRestart",
  unavailable: "update.error.unavailable",
};

export function updaterMessage(state: UpdaterState | null | undefined, { restart = true } = {}): string | undefined {
  if (!state) return undefined;
  const code = state.messageCode && Object.hasOwn(UPDATE_TEXT, state.messageCode) ? UPDATE_TEXT[state.messageCode] : undefined;
  const key = state.messageKey?.startsWith("native.update.") && Object.hasOwn(en, state.messageKey) ? state.messageKey : undefined;
  if (key && activeLocale() === "en") return state.message;
  const params = { ...state.messageParams };
  if (key === "native.update.checkFailed" && code) params.error = t(code);
  if (key === "native.update.installFailed" && params.timedOut === "true") params.reason = t("native.update.installTimedOut");
  const missing = key && [...t(key as LocaleKey).matchAll(/\{(\w+)\}/g)].some(([, name]) => !Object.hasOwn(params, name!));
  const text = key ? missing ? state.message : t(key as LocaleKey, params) : code ? t(code) : state.message;
  return text && (key || code) && restart && state.status === "error" && state.retryable === false ? `${text} ${t("update.error.restartFirst")}` : text;
}
