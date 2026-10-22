import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
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
  if (!state?.messageCode || !Object.hasOwn(UPDATE_TEXT, state.messageCode)) return state?.message;
  const text = t(UPDATE_TEXT[state.messageCode]);
  return restart && state.status === "error" && state.retryable === false ? `${text} ${t("update.error.restartFirst")}` : text;
}
