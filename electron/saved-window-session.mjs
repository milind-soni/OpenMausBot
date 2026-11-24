import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { net, session } from "electron";
import { describeServer } from "./server-probe.mjs";
import { restrictSessionToOrigin } from "./server-session.mjs";

const asset = /^\/assets\/[\w.-]+\.(?:js|css|png|svg|webp|ttf|woff2?)$/;
const icons = new Set(["/app-icon.svg", "/app-icon-192.png", "/app-icon-512.png", "/apple-touch-icon.png", "/manifest.webmanifest"]);

export async function createSavedWindowSession(origin, resourcesPath) {
  const browser = session.fromPartition(`saved-window-${randomUUID()}`);
  restrictSessionToOrigin(browser, origin);
  browser.setPermissionCheckHandler(() => false);
  browser.setPermissionRequestHandler((_page, _permission, answer) => answer(false));
  const server = await describeServer(origin, (...args) => browser.fetch(...args));
  if (!server.ok) throw new Error("The saved server did not answer.");
  const identity = server.environmentId.replace(/[^a-z0-9]/gi, "").slice(0, 12);
  const scheme = new URL(origin).protocol.slice(0, -1);
  browser.protocol.handle(scheme, request => {
    const url = new URL(request.url);
    if (url.origin !== origin) return Response.error();
    if (request.method === "GET" && (url.pathname === "/" || asset.test(url.pathname) || icons.has(url.pathname))) {
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      return net.fetch(pathToFileURL(join(resourcesPath, "ui", file)).href);
    }
    return browser.fetch(request, { bypassCustomProtocolHandlers: true, credentials: "include", redirect: "manual" });
  });
  function dispose() {
    browser.protocol.unhandle(scheme);
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
