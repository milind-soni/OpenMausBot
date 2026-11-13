import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const CUSTOM_DOMAIN_PATH = "/api/settings/custom-domain";

/** Admin-only by request-auth's default deny; only future pairing links change. */
export function createCustomDomainRoutes(deps: {
  desktopManaged: boolean;
  status(): Record<string, unknown>;
  /** Checks the domain's DNS and HTTPS live; throws a refusal the person reads. */
  verify(domain: string): Promise<{ origin: string }>;
  save(origin: string): void;
  sessionEnded(auth: RequestAuth): boolean;
}): RouteHandler {
  let revision = 0;
  const save = (origin: string) => { deps.save(origin); revision++; };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== CUSTOM_DOMAIN_PATH) return PASS;
    res.setHeader?.("cache-control", "no-store");
    if (method === "GET") return json(res, 200, deps.status());
    if (method !== "POST" && method !== "DELETE") return PASS;
    if (deps.desktopManaged) return json(res, 409, { error: "Custom domains are configured on a self-hosted OpenMausBot server, not the desktop companion." });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    if (method === "DELETE") {
      save("");
      return json(res, 200, deps.status());
    }
    const body = await readBody(req, 4096);
    if (typeof body?.domain !== "string") return json(res, 400, { error: "Enter your domain name." });
    const started = revision;
    const verified = await deps.verify(body.domain);
    if (deps.sessionEnded(auth)) return json(res, 401, { error: "Your session ended. Sign in again before connecting a domain." });
    if (started !== revision) return json(res, 409, { error: "Domain settings changed during verification. Try again." });
    save(verified.origin);
    return json(res, 200, deps.status());
  };
}
