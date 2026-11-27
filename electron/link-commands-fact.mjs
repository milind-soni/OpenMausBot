// Whether the person's own Clouds may run commands on this computer now ("Let Clouds run commands on this computer", on
// and not paused), told to the local server over the private parent port when it changes and when a server starts. Work
// that reaches this computer over the link from My Cloud follows it (server/bot-link/far-side.ts); until the server hears
// it, the server holds it off.

/** @param {{ server: () => { postMessage(message: unknown): void } | null, log: (line: string) => void }} options */
export function createLinkCommandsFact({ server, log }) {
  let on = false;
  let sent = null;
  const send = () => {
    const proc = server();
    if (!proc) return;
    if (sent?.proc === proc && sent.on === on) return;
    try {
      proc.postMessage({ type: "openmausbot:link-commands", on });
      sent = { proc, on };
    } catch (error) {
      log(`link commands fact sync failed: ${error?.message ?? error}`);
    }
  };
  return {
    /** Lending's summary (computer-sharing.mjs): its terminal switch, and whether lending is paused. */
    observe(summary) {
      on = Boolean(summary && typeof summary === "object" && summary.terminal === true && summary.paused !== true);
      send();
    },
    serverStarted() {
      sent = null;
      send();
    },
  };
}
