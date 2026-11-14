import type { LocaleKey } from "@/locales";

/** What the main area says while there is no chat to show. `hydrated`: the bots have loaded at least once; `updating`:
 * the window just reloaded My Cloud's page for its newer version (the desktop app says so as the page loads);
 * `developer`: a developer's build, the only one that names the command which starts a server. "No bots yet" only once
 * the bots have loaded and there are none. */
export function loadingLine({ connected, hydrated, updating = window.ogb?.home?.updating === true, developer }: {
  connected: boolean; hydrated: boolean; updating?: boolean; developer: boolean;
}): { text: LocaleKey; busy: boolean; command: boolean } {
  if (connected && hydrated) return { text: "app.loading.noBots", busy: false, command: false };
  return { text: updating && !hydrated ? "app.loading.updating" : "app.loading.connecting", busy: true, command: developer && !connected };
}
