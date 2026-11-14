import { useSyncExternalStore } from "react";
import type { LocaleKey } from "@/locales";
import type { LiveProvider } from "../../shared/wire";
import { desktopCapabilitiesNow } from "./desktop";
import { t } from "./i18n";

export type CallMode = "turns" | "live";
export const CALL_MODE_KEY = "openmausbot.callMode.v1";

export const CALL_MODES: ReadonlyArray<{ id: CallMode; label: LocaleKey }> = [
  { id: "turns", label: "call.mode.turns" },
  { id: "live", label: "call.mode.live" },
];

export function liveDisclosure({ cloudHome = false, azure = false, fish = false }: { cloudHome?: boolean; azure?: boolean; fish?: boolean } = {}): string {
  if (azure) return t(cloudHome ? "call.live.disclosureAzureCloud" : "call.live.disclosureAzure");
  if (fish) return t(cloudHome ? "call.live.disclosureFishCloud" : "call.live.disclosureFish");
  return t(cloudHome ? "call.live.disclosureCloud" : "call.live.disclosure");
}

/** The copy about a Live call's key: Azure and Fish Audio need a key of their own, OpenAI can borrow the OpenAI key. */
export function liveKeyCopy(provider: LiveProvider | undefined) {
  if (provider === "azure") {
    return { title: "call.live.azureKeyTitle", explain: "call.live.azureKeyExplain", field: "call.live.azureKeyField", key: "call.live.azureKey", missing: "call.live.azureNeedsKey", needs: "call.live.needsAzure", cost: "call.live.azureCost" } as const;
  }
  if (provider === "fish") {
    return { title: "call.live.fishKeyTitle", explain: "call.live.fishKeyExplain", field: "call.live.fishKeyField", key: "call.live.fishKey", missing: "call.live.fishNeedsKey", needs: "call.live.needsFish", cost: "call.live.fishCost" } as const;
  }
  return { title: "call.live.keyTitle", explain: "call.live.keyExplain", field: "call.live.keyField", key: "call.live.key", missing: "call.live.needsKey", needs: "call.live.needsKey", cost: "call.live.cost" } as const;
}

export function callModeHint(mode: CallMode, where: { cloudHome?: boolean } = {}): string {
  if (mode === "live") return `${t("call.mode.liveHint")} ${liveDisclosure(where)}`;
  return t(desktopCapabilitiesNow().dictation.engine === "fish-audio" ? "call.mode.turnsHintFish" : "call.mode.turnsHint");
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
