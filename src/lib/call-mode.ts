// Which kind of call the phone button starts, window-wide and remembered.
//
// "turns" is the original call: on-device listening, the bot's configured
// voice, and strict turn-taking (the microphone closes while the bot talks).
// "live" hands the conversation itself to OpenAI GPT-Live — both sides can
// talk at once — while every real request still goes to the bot as a normal
// turn. See server/live-call.ts.
import { useSyncExternalStore } from "react";
import type { LocaleKey } from "@/locales";
import { t } from "./i18n";

export type CallMode = "turns" | "live";
export const CALL_MODE_KEY = "openmausbot.callMode.v1";

/** The modes, as catalog keys (read with t() when shown). */
export const CALL_MODES: ReadonlyArray<{ id: CallMode; label: LocaleKey }> = [
  { id: "turns", label: "call.mode.turns" },
  { id: "live", label: "call.mode.live" },
];

/** What a Live call sends to OpenAI, and where the key stays: on the
 * person's Cloud (`cloudHome`) the key is saved there, not on this computer. */
export function liveDisclosure({ cloudHome = false }: { cloudHome?: boolean } = {}): string {
  return t(cloudHome ? "call.live.disclosureCloud" : "call.live.disclosure");
}

/** What a mode means, in the app's language. Choosing Live is where Live is
 * turned on, so its hint says what a Live call sends to OpenAI. */
export function callModeHint(mode: CallMode, where: { cloudHome?: boolean } = {}): string {
  return mode === "live" ? `${t("call.mode.liveHint")} ${liveDisclosure(where)}` : t("call.mode.turnsHint");
}

/** The call the button makes here. Taking turns listens on this device,
 * which only the Mac app's own page can (`turnsHere`). Anywhere else (a
 * browser, the Windows or Linux app, any server's page such as My Cloud) a
 * call that can be Live is Live, whatever was picked before. The pick is
 * kept for the pages where it applies. */
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
    // Private windows may refuse storage; the choice still holds this session.
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
