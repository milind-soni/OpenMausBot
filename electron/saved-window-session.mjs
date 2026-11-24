import { randomUUID } from "node:crypto";
import { session } from "electron";
import { describeServer } from "./server-probe.mjs";
import { restrictSessionToOrigin } from "./server-session.mjs";

export async function createSavedWindowSession(origin) {
  const browser = session.fromPartition(`saved-window-${randomUUID()}`);
  restrictSessionToOrigin(browser, origin);
  browser.setPermissionCheckHandler(() => false);
  browser.setPermissionRequestHandler((_page, _permission, answer) => answer(false));
  const server = await describeServer(origin, (...args) => browser.fetch(...args));
  if (!server.ok) throw new Error("The saved server did not answer.");
  const identity = server.environmentId.replace(/[^a-z0-9]/gi, "").slice(0, 12);
  function dispose() {
    void browser.closeAllConnections().catch(() => {});
    void browser.clearData().catch(() => {});
  }
  try {
    for (const cookie of await session.defaultSession.cookies.get({ url: origin })) {
      // Chromium scopes cookies by host, so servers on different ports can appear in the same lookup.
      if (!cookie.httpOnly || /^omb_session_\d+_([a-z0-9]+)$/i.exec(cookie.name)?.[1] !== identity) continue;
      const { name, value, secure, httpOnly, sameSite, expirationDate, path } = cookie;
      await browser.cookies.set({ url: origin, name, value, secure, httpOnly, sameSite, expirationDate, path });
    }
    return { browser, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
