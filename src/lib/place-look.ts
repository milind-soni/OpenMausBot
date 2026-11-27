import { useEffect, useState } from "react";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { PlaceColorOutcome, PlaceLook } from "../../electron/place-look.mjs";
import { cloudColor } from "@/lib/cloud-look";

let current: PlaceLook | null = null;
let started = false;
const listeners = new Set<(look: PlaceLook | null) => void>();

function bridge() {
  const workspaces = typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.workspaces;
  return workspaces?.look ? workspaces : undefined;
}

function publish(next: PlaceLook | null) {
  current = next;
  for (const listener of listeners) listener(current);
}

/** Main's word on this page's place again (its colour changed, or the window came back). */
export function refreshPlaceLook(): Promise<void> {
  const workspaces = bridge();
  if (!workspaces?.look) return Promise.resolve();
  return workspaces.look().then((next) => publish(next ?? null), () => {});
}

function start() {
  if (started) return;
  started = true;
  bridge()?.onChanged?.(() => void refreshPlaceLook());
  window.addEventListener("focus", () => void refreshPlaceLook());
  void refreshPlaceLook();
}

/** The colour of the place this page is, and whether it can be changed here: none in a browser and on an older app.
 * The sidebar's tint and Settings read the same one. */
export function usePlaceLook(): PlaceLook | null {
  const [look, setLook] = useState<PlaceLook | null>(current);
  useEffect(() => {
    if (!bridge()) return;
    listeners.add(setLook);
    start();
    setLook(current);
    return () => { listeners.delete(setLook); };
  }, []);
  return look;
}

/** The person chose a swatch: main saves it (on the Admin for a Cloud) and answers the place's look, which the tint and
 * the rail's circle follow at once. */
export async function choosePlaceColor(swatch: CloudSwatch | null): Promise<PlaceColorOutcome> {
  const workspaces = bridge();
  if (!workspaces?.color) return "failed";
  const answer = await workspaces.color(swatch).catch(() => null);
  if (!answer) return "failed";
  publish(answer.look ?? current);
  return answer.outcome;
}

/** The sidebar's tint for a place's colour: that colour in the skin's own tone (styles.css .place-tint fades it out);
 * none without a colour, so the sidebar looks as it always did. */
export function placeTint(color: unknown): { "--place-tint": string } | null {
  const known = cloudColor(color);
  return known ? { "--place-tint": `var(--identity-${known})` } : null;
}
