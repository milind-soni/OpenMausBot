import { useSyncExternalStore } from "react";
import type { LocaleKey } from "@/locales";
import { desktopCapabilitiesNow } from "./desktop";
import { t } from "./i18n";

export type CallMode = "turns" | "live";
export const CALL_MODE_KEY = "openmausbot.callMode.v1";

export const CALL_MODES: ReadonlyArray<{ id: CallMode; label: LocaleKey }> = [
  { id: "turns", label: "call.mode.turns" },
  { id: "live", label: "call.mode.live" },
];

export function liveDisclosure({ cloudHome = false, azure = false }: { cloudHome?: boolean; azure?: boolean } = {}): string {
  if (azure) return t(cloudHome ? "call.live.disclosureAzureCloud" : "call.live.disclosureAzure");
  return t(cloudHome ? "call.live.disclosureCloud" : "call.live.disclosure");
}

export function callModeHint(mode: CallMode, where: { cloudHome?: boolean; serverSpeech?: boolean } = {}): string {
  if (mode === "live") return `${t("call.mode.liveHint")} ${liveDisclosure(where)}`;
  return t((where.serverSpeech ?? desktopCapabilitiesNow().dictation.engine === "fish-audio") ? "stt.turnsHint" : "call.mode.turnsHint");
}

export function effectiveCallMode(stored: CallMode, { turnsHere, canLive }: { turnsHere: boolean; canLive: boolean }): CallMode {
  return canLive && !turnsHere ? "live" : stored;
}

export function parseCallMode(value: string | null): CallMode {
  return value === "live" ? "live" : "turns";
}

function readStored(): CallMode {
  try {
    return parseCallMode(globalThis.localStorage?.getItem(CALL_MODE_KEY) ?? null);
  } catch {
    return "turns";
  }
}

let current: CallMode = readStored();
const watchers = new Set<() => void>();

export function callMode(): CallMode {
  return current;
}

export function setCallMode(next: CallMode): void {
  if (next === current) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(CALL_MODE_KEY, next);
  } catch {
  }
  for (const fn of Array.from(watchers)) fn();
}

export function useCallMode(): CallMode {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
