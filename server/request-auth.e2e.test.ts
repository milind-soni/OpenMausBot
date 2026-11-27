// A real self-hosted server, asked the way a browser on its own machine asks: refused until it signs in once, while
// the CLI keeps working and a development server keeps trusting its local browser.
import { request } from "node:http";
import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { BROWSER_SIGN_IN } from "./request-auth.ts";

/** Headers set exactly as given: Chrome's Sec-Fetch-* and Origin, which a page cannot change. */
function raw(url: string, path: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const target = new URL(path, url);
    const call = request({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers: { host: target.host, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    call.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" }); });
    call.on("error", reject);
    call.end(body);
  });
}

const fromPage = (origin: string) => ({ origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
const otherPage = { origin: "http://localhost:3000", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" };
const navigation = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" };

describe("a browser on a self-hosted server's own machine", () => {
  it("is refused until it signs in once with a pairing code, while the CLI keeps working", async () => {
    const fixture = await launchVerificationServer({ OMB_DEV_TRUST_LOCAL_BROWSER: "0" });
    const url = fixture.info.url;
    try {
      for (const headers of [fromPage(url), otherPage, navigation]) {
        for (const [method, path] of [["GET", "/api/bots"], ["GET", "/api/config"], ["GET", "/api/auth/session"], ["PATCH", "/api/config"]]) {
          const refused = await raw(url, path!, { ...headers, "content-type": "application/json" }, method, method === "PATCH" ? "{}" : undefined);
          expect(refused.status, `${method} ${path}`).toBe(401);
          expect(JSON.parse(refused.body).error).toBe(BROWSER_SIGN_IN);
        }
      }
      const socket = await raw(url, "/api/desktop-viewer/local/shared/websockify", {
        origin: url, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });
      expect(socket.status).toBe(401);
      // Public routes still answer a stranger: the sign-in page needs them.
      expect(await raw(url, "/api/health", fromPage(url)).then((answer) => JSON.parse(answer.body))).toEqual({ app: "openmausbot" });

      // The CLI is Node's fetch, which sends Sec-Fetch-Mode alone.
      const cli = await fetch(`${url}/api/bots`);
      expect(cli.status).toBe(200);
      const opened = await fetch(`${url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const { code } = await opened.json() as { code: string };

      const paired = await raw(url, "/api/auth/pair", { ...fromPage(url), "content-type": "application/json" }, "POST", JSON.stringify({ code, label: "This browser", cookie: true }));
      expect(paired.status).toBe(200);
      const cookie = String(paired.headers["set-cookie"]).split(";", 1)[0]!;
      const signedIn = await raw(url, "/api/bots", { ...fromPage(url), cookie });
      expect(signedIn.status).toBe(200);
      expect(JSON.parse(signedIn.body).bots).toHaveLength(1);
      // The cookie is for this page only: another page on this machine still gets nothing.
      expect((await raw(url, "/api/bots", { ...otherPage, cookie })).status).toBe(403);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("is trusted as before by a development server, which asked for it", async () => {
    const fixture = await launchVerificationServer();
    try {
      expect((await raw(fixture.info.url, "/api/bots", fromPage(fixture.info.url))).status).toBe(200);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
