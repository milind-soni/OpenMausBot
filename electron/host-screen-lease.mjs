// This computer's screen lock, which the desktop's own server keeps: a lent screen call from the person's Cloud takes
// it for as long as the call runs, so the desktop's own bots and that call never use the screen at once. Each refusal
// says its real reason, because a bot told "a person is using it" waits for a person who is not there.

/** The server did not answer the check, or answered something that is not "busy": nobody is using the computer. */
export function screenCheckFailedText(detail) {
  return `OpenMausBot on this computer could not check whether its screen is free (${detail}), so this call was not performed. ` +
    "This is not a person using the computer. Try again in a few seconds; if it keeps happening, tell the person to quit and reopen OpenMausBot on that computer.";
}

async function refusal(response) {
  const body = await response.json().catch(() => null);
  const said = typeof body?.error === "string" && body.error.trim() ? body.error.trim().slice(0, 500) : "";
  // A busy screen (409) and an organization's policy (403 managed_policy) are real answers: they reach the bot as said.
  if (said && (response.status === 409 || body?.code === "managed_policy")) return said;
  return screenCheckFailedText(`its server answered ${response.status}${said ? `: ${said.slice(0, 200)}` : ""}`);
}

/** `hostControl` for createComputerSharing. `url()` is the local server's lease route, read per call because the
 * desktop's server can move to another port; `headers()` carries the desktop's own capability. */
export function createHostScreenLease({ fetch: fetchImpl = globalThis.fetch, url, headers = () => ({}), timeoutMs = 3000 }) {
  return async (id, signal) => {
    const lease = async action => {
      let response;
      try {
        response = await fetchImpl(url(), {
          method: "POST",
          headers: { ...headers(), "content-type": "application/json" },
          body: JSON.stringify({ id, action }),
          signal: action === "release" ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        if (signal.aborted && action !== "release") throw error;
        throw new Error(screenCheckFailedText(error?.name === "TimeoutError" ? `its server did not answer within ${timeoutMs / 1000} seconds` : "its server could not be reached"));
      }
      if (!response.ok) throw new Error(await refusal(response));
      await response.body?.cancel?.().catch(() => {});
    };
    await lease("acquire");
    return { renew: () => lease("acquire"), release: () => lease("release") };
  };
}
