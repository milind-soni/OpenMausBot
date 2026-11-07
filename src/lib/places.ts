import { useEffect, useState } from "react";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { RailPlace, RailState } from "../../electron/cloud-rail.mjs";
import type { PlaceColorOutcome } from "../../electron/place-look.mjs";
import type { CloudRemoveOutcome } from "../../electron/cloud-account.mjs";
import { ipcErrorText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";

const NONE: RailState = { places: [], add: { cloud: false, link: false, address: false } };
let current: RailState = NONE;
let started = false;
const listeners = new Set<(state: RailState) => void>();

function bridge() {
  const workspaces = typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.workspaces;
  return workspaces?.places ? workspaces : undefined;
}

/** Main's list again (it changed, or the window came back): every rail and switcher on the page sees the same one. */
export function refreshPlaces(): Promise<void> {
  const workspaces = bridge();
  if (!workspaces?.places) return Promise.resolve();
  return workspaces.places().then((next) => {
    current = next && Array.isArray(next.places) ? next : NONE;
    for (const listener of listeners) listener(current);
  }, () => {});
}

function start() {
  if (started) return;
  started = true;
  bridge()?.onChanged?.(() => void refreshPlaces());
  window.addEventListener("focus", () => void refreshPlaces());
  void refreshPlaces();
}

/** The rail's places as main lists them for this page: none in a browser, on an older app, on a server's own page, or with
 * fewer than two places. */
export function usePlaces(): RailState {
  const [state, setState] = useState<RailState>(current);
  useEffect(() => {
    if (!bridge()) return;
    listeners.add(setState);
    start();
    setState(current);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

/** A place's colour, chosen in its menu on the window's rail: main saves it (on the Admin for a Cloud) whatever that
 * place's server runs, and the circle shows it once the list is read again. */
export async function recolorPlace(id: string, swatch: CloudSwatch | null): Promise<PlaceColorOutcome> {
  const answer = await bridge()?.recolor?.(id, swatch).catch(() => null);
  if (!answer) return "failed";
  if (answer.outcome === "saved") void refreshPlaces();
  return answer.outcome;
}

/** Remove from list, from a circle's menu once the person said yes: main takes that Cloud off their list on the Admin, and
 * the circle goes with main's next list. An older app (no such channel) answers `unsupported`. */
export async function removePlace(id: string): Promise<CloudRemoveOutcome> {
  const remove = bridge()?.remove;
  if (!remove) return "unsupported";
  const answer = await remove(id).catch(() => null);
  if (!answer) return "failed";
  if (answer.outcome === "removed" || answer.outcome === "gone") void refreshPlaces();
  return answer.outcome;
}

/** Make … my home, from a server's menu: main starts moving this computer's bots there. True once it started, else main's
 * own words for why not. */
export async function makeHome(id: string): Promise<true | string> {
  const start = bridge()?.makeHome;
  if (!start) return t("rail.makeHomeFailed");
  try {
    await start(id);
    void refreshPlaces();
    return true;
  } catch (cause) {
    return ipcErrorText(cause) ?? t("rail.makeHomeFailed");
  }
}

/** Whether a rail of places stands beside this page: the window's own (main says so: `beside`), or one drawn on it from a
 * list main gave it (two places or more). */
export const railShown = (state: RailState): boolean => state.beside === true || state.places.length > 0;

/** This computer's circle: This computer, or a workspace of its own (a profile): its own name, else as the app names this
 * computer elsewhere, This Mac or This PC. */
export function computerName(place: Pick<RailPlace, "profile"> & Partial<Pick<RailPlace, "named" | "name">>, platform: string | undefined = typeof window === "undefined" ? undefined : window.ogb?.platform): string {
  if (!place.profile) return t("rail.thisComputer");
  if (place.named && place.name) return place.name;
  return t(platform === "darwin" ? "rail.thisMac" : "rail.thisPc");
}

/** A new workspace's first name: Work, then Personal, then Workspace 2, 3 and on, whichever no place here has yet. */
export function suggestedLocalName(taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLocaleLowerCase()));
  const free = (name: string) => !used.has(name.toLocaleLowerCase());
  for (const name of [t("rail.localWork"), t("rail.localPersonal")]) if (free(name)) return name;
  for (let count = 2; ; count++) { const name = t("rail.localNumbered", { count }); if (free(name)) return name; }
}

/** A new workspace of this computer's own, from ＋: main makes it and opens it next. */
export async function createLocal(name: string, color: CloudSwatch | null): Promise<"made" | "name" | "taken" | "failed"> {
  const answer = await bridge()?.local?.create(name, color).catch(() => null);
  if (!answer) return "failed";
  if (answer.outcome === "made") void refreshPlaces();
  return answer.outcome;
}

/** A workspace's new name or colour, from its circle's menu. */
export async function editLocal(id: string, changes: { name: string } | { color: CloudSwatch | null }): Promise<"saved" | "name" | "taken" | "failed"> {
  const answer = await bridge()?.local?.edit(id, changes).catch(() => null);
  if (!answer) return "failed";
  if (answer.outcome === "saved") void refreshPlaces();
  return answer.outcome === "saved" || answer.outcome === "name" || answer.outcome === "taken" ? answer.outcome : "failed";
}

/** Removes a workspace from this computer, once the person said yes in its circle's menu. */
export async function removeLocal(id: string): Promise<"removed" | "failed"> {
  const answer = await bridge()?.local?.remove(id).catch(() => null);
  if (answer?.outcome === "removed" || answer?.outcome === "gone") { void refreshPlaces(); return "removed"; }
  return "failed";
}

/** A circle's letters: the first of up to two words, so "Client A" is CA and "Acme" is A. */
export function placeInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (word: string | undefined) => (word ? Array.from(word)[0] ?? "" : "");
  return (first(words[0]) + (words.length > 1 ? first(words[1]) : "")).toLocaleUpperCase();
}

export type { RailPlace, RailState };
