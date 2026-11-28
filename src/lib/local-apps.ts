// The person's saved apps: one list for the whole window, read once and kept fresh after each change, and which app is
// open in its own view, if any.
import { useSyncExternalStore } from "react";
import type { AppDocument } from "../../shared/app";
import type { LocalApp, LocalAppsList } from "../../shared/local-apps";
import { api, ApiError } from "@/state/api";
import { afterRemoved, afterRenamed, tidyInstalled } from "@/lib/local-app-install";

export type LocalAppsState = { status: "idle" | "loading" | "failed"; apps: readonly LocalApp[] | null };

let state: LocalAppsState = { status: "idle", apps: null };
let openId: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function changed(next: Partial<LocalAppsState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function loadLocalApps(): Promise<void> {
  loading ??= (async () => {
    if (!state.apps) changed({ status: "loading" });
    try {
      const list = await api<LocalAppsList>("/api/local-apps");
      const apps = Array.isArray(list?.apps) ? list.apps : [];
      changed({ status: "idle", apps });
      void tidyInstalled(apps.map((app) => app.id));
    } catch {
      changed({ status: "failed" });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function useLocalApps(): LocalAppsState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

function put(app: LocalApp): void {
  if (!state.apps) {
    void loadLocalApps().then(() => { if (state.apps && !state.apps.some((one) => one.id === app.id)) put(app); });
    return;
  }
  const apps = state.apps;
  changed({ apps: apps.some((one) => one.id === app.id) ? apps.map((one) => (one.id === app.id ? app : one)) : [app, ...apps] });
}

/** The app saved from this page, once the list has been read. */
export function savedAppFor(apps: readonly LocalApp[] | null, threadId: string, messageId: string): LocalApp | undefined {
  return apps?.find((app) => app.threadId === threadId && app.messageId === messageId);
}

export async function saveLocalApp(page: { botId: string; threadId: string; messageId: string }): Promise<LocalApp> {
  const { app } = await api<{ app: LocalApp }>("/api/local-apps", { method: "POST", body: JSON.stringify(page) });
  put(app);
  return app;
}

const onePath = (id: string) => `/api/local-apps/${encodeURIComponent(id)}`;

export async function changeLocalApp(id: string, change: { name?: string; pinnedRev?: number | null }): Promise<LocalApp> {
  const { app } = await api<{ app: LocalApp }>(onePath(id), { method: "PATCH", body: JSON.stringify(change) });
  put(app);
  if (change.name !== undefined) void afterRenamed(app);
  return app;
}

/** Leaves the list at once; `restore` puts it back where it was if the person undoes before the server is told. */
export function hideLocalApp(id: string): { restore(): void } {
  const before = state.apps ?? [];
  const at = before.findIndex((app) => app.id === id);
  const app = before[at];
  changed({ apps: before.filter((one) => one.id !== id) });
  return {
    restore: () => {
      if (!app || state.apps?.some((one) => one.id === id)) return;
      const apps = [...(state.apps ?? [])];
      apps.splice(Math.min(at, apps.length), 0, app);
      changed({ apps });
    },
  };
}

export async function removeLocalApp(id: string): Promise<void> {
  try {
    await api(onePath(id), { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  await afterRemoved(id);
}

export function localAppDocumentPath(id: string): string {
  return `${onePath(id)}/app`;
}

/** A folder page's files load from this window's own origin, where /api answers. */
export async function fetchLocalAppDocument(id: string, rev?: number, signal?: AbortSignal): Promise<AppDocument> {
  const query = new URLSearchParams({ origin: window.location.origin, ...(rev === undefined ? {} : { rev: String(rev) }) });
  return api<AppDocument>(`${localAppDocumentPath(id)}?${query}`, { signal });
}

export function openLocalApp(id: string | null): void {
  if (openId === id) return;
  openId = id;
  for (const listener of listeners) listener();
}

export function openLocalAppId(): string | null {
  return openId;
}

export function useOpenLocalApp(): string | null {
  return useSyncExternalStore(subscribe, () => openId, () => openId);
}

/** Test seam: forget the list and the open app. */
export function resetLocalApps(apps: readonly LocalApp[] | null = null): void {
  loading = null;
  openId = null;
  changed({ status: "idle", apps });
}
