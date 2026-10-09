import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";

const listen = (server: Server) => new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const close = (server: Server) => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

describe("browser authorization while the harness is responding", () => {
  for (const kind of ["stream", "json", "json-body"] as const) {
    for (const revoke of ["grant", "device"] as const) {
      it(`withholds ${kind} after ${revoke} revocation and permits a fresh grant`, async () => {
        let valid = true;
        let allowed = true;
        let delayed = true;
        let respond = () => {};
        let reached = () => {};
        const upstreamReached = new Promise<void>((resolve) => { reached = resolve; });
        const secret = "synthetic-signed-in-browser";
        const upstream = createServer((_request, response) => {
          const writeHeaders = () => response.writeHead(200, {
            "content-type": kind === "stream" ? "text/event-stream" : "application/json",
          });
          const writeBody = () => response.end(kind === "stream"
            ? `event: url\ndata: {"url":"${secret}"}\n\n`
            : JSON.stringify({ url: secret }));
          if (!delayed) { writeHeaders(); writeBody(); return; }
          if (kind === "json-body") { writeHeaders(); response.flushHeaders(); }
          respond = () => { if (kind !== "json-body") writeHeaders(); writeBody(); };
          reached();
        });
        const upstreamPort = await listen(upstream);
        const handler = createProxyHandler({
          harnessPort: upstreamPort,
          authenticate: (token) => token === "fixture-token" && valid
            ? { id: "fixture-phone", cloudDesktopAccess: false, browserControlAccess: allowed } : null,
          redeem: () => ({ error: "offline fixture" }),
          serverName: () => "Synthetic computer",
        });
        const relay = createServer(handler);
        const relayPort = await listen(relay);
        const path = `/api/bots/fixture/browser/${kind === "stream" ? "live" : "action"}`;
        const options = {
          method: kind === "stream" ? "GET" : "POST",
          headers: { authorization: "Bearer fixture-token" },
          signal: AbortSignal.timeout(3000),
        };
        try {
          const pending = fetch(`http://127.0.0.1:${relayPort}${path}`, options);
          await upstreamReached;
          if (revoke === "grant") allowed = false; else valid = false;
          handler.disconnectDevice("fixture-phone");
          respond();
          const refused = await pending;
          expect(refused.status).toBe(revoke === "grant" ? 403 : 401);
          expect(await refused.text()).not.toContain(secret);

          valid = true;
          allowed = true;
          delayed = false;
          const fresh = await fetch(`http://127.0.0.1:${relayPort}${path}`, options);
          expect(fresh.status).toBe(200);
          expect(await fresh.text()).toContain(secret);
        } finally {
          await close(relay);
          await close(upstream);
        }
      });
    }
  }
});
