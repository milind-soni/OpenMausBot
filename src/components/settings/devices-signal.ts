import { useSyncExternalStore } from "react";

/** What the Devices page last saw, for the mark beside Devices in the nav: kept for the place it was read on. */
export interface DevicesSignal {
  place: string;
  needsYou: boolean;
  phoneConnected: boolean;
}

let signal: DevicesSignal | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setDevicesSignal(next: DevicesSignal | null): void {
  if (next === signal || (next && signal && next.place === signal.place && next.needsYou === signal.needsYou && next.phoneConnected === signal.phoneConnected)) return;
  signal = next;
  for (const listener of listeners) listener();
}

/** The Devices page's last word for `place`, or null before that page has read it. */
export function useDevicesSignal(place: string): DevicesSignal | null {
  const now = useSyncExternalStore(subscribe, () => signal, () => signal);
  return now?.place === place ? now : null;
}

export const devicesPlaceKey = (place: { kind: string; name: string }) => `${place.kind}:${place.name}`;

export type NavDot = "success" | "warning";

/** Amber while anything on Devices needs the person; green while a phone is connected and nothing does. */
export function devicesDot(signal: DevicesSignal): NavDot | null {
  if (signal.needsYou) return "warning";
  return signal.phoneConnected ? "success" : null;
}
