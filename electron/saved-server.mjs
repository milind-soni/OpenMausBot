// A server connected by hand, before the window goes there: the window goes only to a server that answers; one that
// doesn't (its name no longer resolves, nothing listens) is the person's choice: try again, remove it, or stay.

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
export async function serverOpens(entry, { fetch: fetchImpl, dialog, forget, timeoutMs = SERVER_LOOK_MS }) {
  for (;;) {
    if (await serverAnswers(entry.origin, fetchImpl, timeoutMs)) return true;
    const { response } = await dialog.showMessageBox({
      type: "warning", buttons: ["Try again", "Remove from list", "Cancel"], defaultId: 0, cancelId: 2,
      message: `${entry.name} isn't answering`,
      detail: `Nothing answers at ${new URL(entry.origin).host}. If that server is gone for good, remove it from your list. Your bots elsewhere aren't affected.`,
    });
    if (response === 1) { await forget(entry.id); return false; }
    if (response !== 0) return false;
  }
}
