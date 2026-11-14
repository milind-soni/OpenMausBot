// Published pages' access on the desktop: every signed-in MausBot account may publish (a free one has its free pages),
// so as soon as this computer is signed in, its sign-in's own pages token is fetched from the Admin once and handed to
// the local server over the private parent port (server/pages/access.ts). Kept in memory only; a sign-out clears it.
import { createIncludedXSync } from "./included-x.mjs";

const signedInDevice = (state) => state?.status === "connected" && typeof state.deviceId === "string" ? state.deviceId : null;

/**
 * @param {{ account: () => { pagesAccess(): Promise<{ url: string; token: string } | null> } | null,
 *   server: () => { postMessage(message: unknown): void } | null, log: (line: string) => void }} options
 */
export function createDesktopIncludedPages({ account, server, log }) {
  return createIncludedXSync({
    device: signedInDevice,
    fetchAccess: () => account()?.pagesAccess() ?? Promise.resolve(null),
    send: (access, note) => {
      const proc = server();
      if (!proc) return;
      // `offered: false`: signed in, but the Admin has no pages for this sign-in yet (not "sign in").
      try { proc.postMessage({ type: "openmausbot:included-pages", access, ...(note?.offered === false ? { offered: false } : {}) }); }
      catch (error) { log(`Pages access sync failed: ${error?.message ?? error}`); }
    },
  });
}
