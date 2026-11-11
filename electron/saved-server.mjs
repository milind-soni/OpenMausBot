// A server connected by hand, before the window goes there: the window goes only to a server that answers; one that
// doesn't (its name no longer resolves, nothing listens) is the person's choice: try again, remove it, or stay.

import nativeText from "./native-text.cjs";

/** How long a server has to answer before it counts as not answering. */
export const SERVER_LOOK_MS = 3_000;

/** Whether anything answers at `origin` (any HTTP status but a 5xx from a proxy in front of a stopped app). */
export async function serverAnswers(origin, fetchImpl, timeoutMs = SERVER_LOOK_MS) {
  try {
    const response = await fetchImpl(`${origin}/.well-known/openmausbot/environment`, {
      cache: "no-store", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" },
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * True when the window may go to `entry` now. A server that doesn't answer asks the person, in one dialog: Try again
 * (looks once more), Remove from list (`forget(entry.id)`, then false), or Cancel (false: the window stays where it is).
 * @param {{ id: string, name: string, origin: string }} entry
 * @param {{ fetch: typeof fetch, dialog: { showMessageBox(options: object): Promise<{ response: number }> }, forget: (id: string) => unknown, timeoutMs?: number }} deps
 */
export async function serverOpens(entry, { fetch: fetchImpl, dialog, forget, timeoutMs = SERVER_LOOK_MS, t = nativeText.englishText.t }) {
  for (;;) {
    if (await serverAnswers(entry.origin, fetchImpl, timeoutMs)) return true;
    const { response } = await dialog.showMessageBox({
      type: "warning", buttons: [t("cloudHome.tryAgain"), t("rail.remove"), t("native.common.cancel")], defaultId: 0, cancelId: 2,
      message: t("native.server.notAnswering", { name: entry.name }),
      detail: t("native.server.notAnsweringDetail", { host: new URL(entry.origin).host }),
    });
    if (response === 1) { await forget(entry.id); return false; }
    if (response !== 0) return false;
  }
}

/**
 * The window's way back to a server this computer's bots moved to: opens it again as the Server menu does, without that
 * menu's dialog, because this is the app putting itself right and the screen it lands on has Try again. False when the
 * server isn't saved here any more, nothing answers at it, or `still()` says a newer `show()` took over.
 * @param {{ origin: string | null }} place
 * @param {{ saved(): Array<{ id: string, origin: string }>, fetch: typeof fetch, still?(): boolean, opened(entry: object): unknown }} deps
 */
export async function reopenSavedServer({ origin }, { saved, fetch: fetchImpl, still = () => true, opened }) {
  const entry = origin ? saved().find((candidate) => candidate.origin === origin) ?? null : null;
  if (!entry) return false;
  if (!(await serverAnswers(entry.origin, fetchImpl))) return false;
  if (!saved().some((candidate) => candidate.id === entry.id)) return false;
  if (!still()) return false;
  return Boolean(await opened(entry));
}
