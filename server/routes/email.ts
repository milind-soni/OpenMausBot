// Owner/admin routes for the person's mailboxes. A client session never reaches these: request-auth denies any route not
// on its allow-list. No answer ever carries a password.
import { z } from "zod";

import type { EmailService } from "../email/service.ts";
import { PASS, type RouteHandler } from "./table.ts";

const body = z.object({
  address: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(4_096),
  imapHost: z.string().trim().max(253).optional(),
  imapPort: z.number().int().min(1).max(65_535).optional(),
  smtpHost: z.string().trim().max(253).optional(),
  smtpPort: z.number().int().min(1).max(65_535).optional(),
  username: z.string().trim().max(320).optional(),
}).strict();

const ACCOUNT = /^\/api\/email\/accounts\/([^/]{3,960})$/u;

export function createEmailRoutes(deps: { service: EmailService }): RouteHandler {
  const { service } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/email" && !path.startsWith("/api/email/")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the owner or an admin can manage the mailboxes." });
    res.setHeader("Cache-Control", "no-store");
    if (path === "/api/email") return method === "GET" ? json(res, 200, service.status()) : json(res, 405, { error: "method not allowed" });
    if (path === "/api/email/accounts") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = body.safeParse(await readBody(req, 20_480));
      if (!parsed.success) return json(res, 400, { error: "Enter your email address and password." });
      const answer = await service.connect(parsed.data);
      return json(res, 200, answer);
    }
    const one = ACCOUNT.exec(path);
    if (one && method === "DELETE") return json(res, 200, service.disconnect(decodeURIComponent(one[1]!)));
    return json(res, 404, { error: "not found" });
  };
}
