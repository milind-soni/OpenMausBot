// The place a launch opens: the one on screen when the app last closed. One that can't open now falls back without a
// dialog: to My Cloud, and when My Cloud doesn't run either, to This Mac. A workspace of this computer's own opens only
// through `profiles`, so one runs at a time and the frozen copy is never one of them.
import { DEFAULT_PROFILE } from "./clean-workspace.mjs";

/**
 * @param {{
 *   home: { refresh(): Promise<{ kind: string }>, show(options?: object): Promise<unknown>, opensNow(ask: unknown): boolean | null },
 *   places: { remembered(): any, remember(place: null): void },
 *   profiles: { open(id: string): Promise<boolean | null> } | null,
 *   server(id: string): Promise<boolean>,
 *   log?(line: string): void,
 * }} deps `home`: the home window. `profiles`: the workspaces of this computer's own, null where there are
 * none. `server(id)`: opens the server saved by hand under that id without a dialog, false when it isn't saved or doesn't
 * answer in a short wait.
 * @returns {Promise<"remembered" | "cloud" | "this-mac" | "home">} where the window went: the remembered place, My Cloud
 * instead of it, This Mac instead of both, or home as worked out with nothing remembered (or nobody signed in).
 */
export async function openStartPlace({ home, places, profiles, server, log = () => {} }) {
  const { kind } = await home.refresh();
  const last = places.remembered();
  // Signed out, nothing of the account's opens: home shows as ever, and the place waits for the person to be back.
  if (!last || home.opensNow("cloud") === null) { await home.show(); return "home"; }
  if (await reopens(last)) return "remembered";
  log(`start: the place open last time can't open now (${Object.keys(last)[0]}); My Cloud instead`);
  places.remember(null);
  if (kind === "cloud" && home.opensNow("cloud") === false && profiles && (await profiles.open(DEFAULT_PROFILE)) === true) return "this-mac";
  await home.show();
  return "cloud";

  async function reopens(place) {
    if (typeof place.profile === "string") return Boolean(profiles) && (await profiles.open(place.profile)) === true;
    if (typeof place.server === "string") return kind === "cloud" && (await server(place.server).catch(() => false)) === true;
    if (!home.opensNow(place)) return false;
    await home.show();
    return true;
  }
}
