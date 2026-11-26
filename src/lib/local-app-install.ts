// Saved apps installed as launchers on this computer (the desktop app's own page only): which are, Install and
// Uninstall, an icon on the Desktop, and keeping the launchers in step with the saved apps (gone, renamed).
import { useSyncExternalStore } from "react";
import type { LocalApp } from "../../shared/local-apps";
import { appIconPng } from "@/lib/app-icon";

/** `desktop`: the apps whose icon is on the Desktop too; `canDesktop`: this desktop build can put one there. */
export type AppInstallState = { available: boolean; ids: ReadonlySet<string>; desktop?: ReadonlySet<string>; canDesktop?: boolean } | null;

let state: AppInstallState = null;
const listeners = new Set<() => void>();

const bridge = () => (typeof window === "undefined" ? undefined : window.ogb?.appInstall);
const canDesktop = () => typeof bridge()?.addToDesktop === "function" && typeof bridge()?.removeFromDesktop === "function";
const without = (set: ReadonlySet<string> | undefined, id: string) => new Set([...(set ?? [])].filter((one) => one !== id));

function changed(next: AppInstallState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** null outside the desktop app, and until the first read. */
export function useAppInstall(): AppInstallState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export async function readInstalled(): Promise<void> {
  const install = bridge();
  if (!install) return;
  try {
    const { available, apps } = await install.list();
    changed({
      available: available === true, ids: new Set(apps.map((app) => app.id)),
      desktop: new Set(apps.filter((app) => app.desktop === true).map((app) => app.id)), canDesktop: canDesktop(),
    });
  } catch {
    changed({ available: false, ids: new Set(), desktop: new Set(), canDesktop: false });
  }
}

/** After the whole list of saved apps was read: launchers of apps that are gone are removed. */
export async function tidyInstalled(ids: readonly string[]): Promise<void> {
  const install = bridge();
  if (!install) return;
  await install.cleanup?.([...ids]).catch(() => undefined);
  await readInstalled();
}

/** Rejects when the launcher could not be written. */
export async function installLocalApp(app: Pick<LocalApp, "id" | "name" | "bot">): Promise<void> {
  const install = bridge();
  if (!install) throw new Error("unavailable");
  const iconPng = await appIconPng(app.name, app.bot?.color).catch(() => undefined);
  const answer = await install.install({ id: app.id, name: app.name, ...(iconPng ? { iconPng } : {}) });
  if (!answer.ok) throw new Error(answer.reason);
  changed({ ...state, available: true, ids: new Set([...(state?.ids ?? []), app.id]) });
}

export async function uninstallLocalApp(id: string): Promise<void> {
  const install = bridge();
  if (!install) return;
  const answer = await install.uninstall(id);
  if (!answer.ok) throw new Error(answer.reason);
  changed({ ...state, available: state?.available ?? true, ids: without(state?.ids, id), desktop: without(state?.desktop, id) });
}

export const isOnDesktop = (id: string) => Boolean(state?.desktop?.has(id));

/** Rejects with "install" when installing it first failed, else with the reason the Desktop item could not be written. */
export async function addLocalAppToDesktop(app: Pick<LocalApp, "id" | "name" | "bot">): Promise<void> {
  const install = bridge();
  if (!install?.addToDesktop) throw new Error("unavailable");
  if (!isInstalled(app.id)) await installLocalApp(app).catch(() => { throw new Error("install"); });
  const answer = await install.addToDesktop(app.id);
  if (!answer.ok) throw new Error(answer.reason);
  changed({ ...state, available: true, ids: new Set([...(state?.ids ?? []), app.id]), desktop: new Set([...(state?.desktop ?? []), app.id]) });
}

export async function removeLocalAppFromDesktop(id: string): Promise<void> {
  const install = bridge();
  if (!install?.removeFromDesktop) return;
  const answer = await install.removeFromDesktop(id);
  if (!answer.ok) throw new Error(answer.reason);
  changed({ ...state, available: state?.available ?? true, ids: state?.ids ?? new Set(), desktop: without(state?.desktop, id) });
}

export const isInstalled = (id: string) => Boolean(state?.ids.has(id));

/** The app is gone for good: so is its launcher. */
export async function afterRemoved(id: string): Promise<void> {
  if (isInstalled(id)) await uninstallLocalApp(id).catch(() => undefined);
}

/** A renamed app's launcher takes the new name. */
export async function afterRenamed(app: LocalApp): Promise<void> {
  if (isInstalled(app.id)) await installLocalApp(app).catch(() => undefined);
}

/** Test seam. */
export function resetAppInstall(next: AppInstallState = null): void {
  changed(next);
}
