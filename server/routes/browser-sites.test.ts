import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BrowserSitesTarget } from "../browser-sites.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createBrowserSiteRoutes, type BrowserSitesRef } from "./browser-sites.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const asked: BrowserSitesRef[] = [];
  const threads: Array<string | null> = [];
  const signedOut: Array<{ session: string; site: string | null }> = [];
  const routes = [createBrowserSiteRoutes({
    target: (which, threadId) => {
      asked.push(which);
      threads.push(threadId);
      if ("bot" in which && which.bot === "guest-bot") return { status: 409, error: "A temporary browser saves no sign-ins." };
      return { binaryPath: "/engine", session: "bot-pepper", env: {}, encryptionKey: "k" } satisfies BrowserSitesTarget;
    },
    list: async () => ({ running: false, sites: [{ site: "example.com", cookies: 2, storage: 1 }] }),
    signOut: async (target, site) => { signedOut.push({ session: target.session, site }); return { running: true, sites: [] }; },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, type = "application/json") => fetch(`${base}/api/browser-sites/sign-out`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  return { base, asked, threads, signedOut, post };
}

describe("signed-in sites routes", () => {
  it("are for admins only, like the browser profiles", () => {
    expect(requiredScope("GET", "/api/browser-sites")).toBe("admin");
    expect(requiredScope("POST", "/api/browser-sites/sign-out")).toBe("admin");
  });

  it("list one profile's or one bot's sites", async () => {
    const { base, asked } = await serve();
    const response = await fetch(`${base}/api/browser-sites?profile=profile-work`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ running: false, sites: [{ site: "example.com", cookies: 2, storage: 1 }] });
    expect((await fetch(`${base}/api/browser-sites?bot=pepper`)).status).toBe(200);
    expect(asked).toEqual([{ profile: "profile-work" }, { bot: "pepper" }]);
  });

  it("need exactly one profile or bot, and pass the server's reason through", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/browser-sites`)).status).toBe(400);
    expect((await fetch(`${base}/api/browser-sites?profile=a&bot=b`)).status).toBe(400);
    const guest = await fetch(`${base}/api/browser-sites?bot=guest-bot`);
    expect(guest.status).toBe(409);
    expect(await guest.json()).toEqual({ error: "A temporary browser saves no sign-ins." });
  });

  it("sign out of one site, or of all when no site is named", async () => {
    const { post, signedOut } = await serve();
    expect((await post({ profile: "profile-work", site: "example.com" })).status).toBe(200);
    expect((await post({ bot: "pepper" })).status).toBe(200);
    expect(signedOut).toEqual([{ session: "bot-pepper", site: "example.com" }, { session: "bot-pepper", site: null }]);
  });

  it("refuse a form post, a bad site and a missing target", async () => {
    const { post, signedOut } = await serve();
    expect((await post({ profile: "profile-work" }, "text/plain")).status).toBe(415);
    expect((await post({ profile: "profile-work", site: "../../etc" })).status).toBe(400);
    expect((await post({ profile: "profile-work", site: 7 })).status).toBe(400);
    expect((await post({ site: "example.com" })).status).toBe(400);
    expect(signedOut).toEqual([]);
  });
});

describe("signed-in sites of one conversation's browser on a Team Cloud", () => {
  it("name the conversation for the server to find its audience's browser, and nothing without one", async () => {
    const { base, threads, post } = await serve();
    expect((await fetch(`${base}/api/browser-sites?bot=pepper&threadId=ada-chat`)).status).toBe(200);
    expect((await fetch(`${base}/api/browser-sites?bot=pepper`)).status).toBe(200);
    expect((await post({ bot: "pepper", threadId: "ada-chat", site: "example.com" })).status).toBe(200);
    expect((await post({ bot: "pepper" })).status).toBe(200);
    expect(threads).toEqual(["ada-chat", null, "ada-chat", null]);
  });
});
