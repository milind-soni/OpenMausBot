import type { InkboxSetup } from "../inkbox-setup.ts";
import { InkboxSetupError } from "../inkbox-provider.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InkboxSetupRouteDeps {
  setup: Pick<InkboxSetup, "snapshot" | "setup" | "reconnect" | "disconnect">;
}

/** This manager may hold credentials, but these routes expose its public
 * snapshot only. A paired session, including a remote admin, cannot provision. */
export function createInkboxSetupRoutes({ setup }: InkboxSetupRouteDeps): RouteHandler {
  const root = "/api/inkbox/setup";
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== root && path !== `${root}/reconnect` && path !== `${root}/disconnect`) return PASS;
    res.setHeader("cache-control", "no-store");
    if (auth.kind !== "loopback" || auth.trust === "service" || !auth.scopes.includes("admin")) {
      return json(res, 403, { error: "Manage iMessage from the local desktop app." });
    }
    if (method !== "POST" && !(path === root && method === "GET")) {
      res.setHeader("allow", path === root ? "GET, POST" : "POST");
      return json(res, 405, { error: "This iMessage operation does not support that method." });
    }
    try {
      if (method === "GET") return json(res, 200, setup.snapshot());
      if (!setup.snapshot().available) return json(res, 503, { error: "Secure iMessage setup is available only in the local desktop app." });
      if (path === root) {
        let body: unknown;
        try { body = await readBody(req, 16_000); }
        catch (error) {
          const oversized = typeof error === "object" && error !== null && "status" in error && error.status === 413;
          return json(res, oversized ? 413 : 400, { error: oversized ? "The iMessage setup request is too large." : "The iMessage setup request must contain valid JSON." });
        }
        // The manager validates the domain schema before storing or sending it.
        await setup.setup(body as Parameters<InkboxSetup["setup"]>[0]);
      } else if (path === `${root}/reconnect`) await setup.reconnect();
      else await setup.disconnect();
      return json(res, 200, setup.snapshot());
    } catch (error) {
      if (error instanceof InkboxSetupError) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        return json(res, status, { error: error.message.slice(0, 400) });
      }
      return json(res, 503, { error: "Could not finish iMessage setup. Check your connection and try again." });
    }
  };
}
