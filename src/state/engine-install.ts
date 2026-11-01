// What the server says about installing an engine on the machine it runs on, and what the last install changed.
import { useSyncExternalStore } from "react";

export interface EngineInstall {
  platform?: "darwin" | "win32" | "linux";
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  managed?: { label: string; downloadBytes: number };
  server?: { package?: string; standalone?: { version: string; downloadBytes: number } };
  settings?: "connections";
  /** The CLI runs the copy OpenMausBot installed, which the person's terminal does not reach: set up in the app, not there. */
  appCopy?: boolean;
}

// Engines an install switched to the app's own copy because the copy their CLI found doesn't start. The line saying so
// outlives the setup panel that showed it (the engine turns Ready), until the person dismisses it or leaves Settings.
let switched: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>): void {
  switched = next;
  for (const listener of listeners) listener();
}

/** The last install of this engine switched it to the app's copy (`true`), or did not. */
export function noteAppCopySwitch(instanceId: string, didSwitch: boolean): void {
  if (switched.has(instanceId) === didSwitch) return;
  const next = new Set(switched);
  if (didSwitch) next.add(instanceId);
  else next.delete(instanceId);
  publish(next);
}

export function dismissAppCopySwitch(instanceId: string): void {
  noteAppCopySwitch(instanceId, false);
}

export function forgetAppCopySwitches(): void {
  if (switched.size) publish(new Set());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppCopySwitch(instanceId: string): boolean {
  const read = () => switched.has(instanceId);
  return useSyncExternalStore(subscribe, read, read);
}
