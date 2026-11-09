import { appointmentSchema, ChiefOperator, OperatorRefusal, revocationSchema } from "../chief-operator.ts";
import type { IncomingMessage } from "node:http";
import { desktopOwnerRequest, type RequestAuth } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function chiefOperatorOwner(auth: RequestAuth, req: IncomingMessage, options: { team: boolean; desktopManaged: boolean; desktopMutationToken?: string; sessions: Pick<SessionRegistry, "isLive">; ownerActive(owner: string): boolean }): string | null {
  if (auth.kind === "loopback") return options.desktopManaged && !auth.companionDevice && desktopOwnerRequest(req, options.desktopMutationToken) ? "local-owner" : null;
  if (!options.sessions.isLive(auth.session.id) || !auth.scopes.includes("admin")) return null;
  if (options.team && (auth.session.membershipAuthority !== "team" || auth.session.teamRole !== "owner")) return null;
  const owner = auth.session.email ?? auth.session.owner ?? auth.session.id;
  return options.ownerActive(owner) ? owner : null;
}

export function createChiefOperatorRoutes(operator: ChiefOperator, ownerOf: (auth: RequestAuth, req: IncomingMessage) => string | null): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/chief-operator" || !["GET", "PUT", "DELETE"].includes(method)) return PASS;
    const owner = ownerOf(auth, req);
    if (!owner) { req.resume(); return json(res, 403, { error: "Only the workspace owner can appoint or inspect a Chief Operator." }); }
    try {
      if (method === "GET") return json(res, 200, operator.appointment());
      const body = await readBody(req);
      if (ownerOf(auth, req) !== owner) return json(res, 403, { error: "Only the workspace owner can appoint or inspect a Chief Operator." });
      if (method === "PUT") {
        const parsed = appointmentSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Send an existing botId, read and write setting arrays, and the current expectedRevision." });
        return json(res, 200, operator.appoint(parsed.data, owner));
      }
      const parsed = revocationSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "Send the current expectedRevision to revoke the appointment." });
      return json(res, 200, operator.revoke(parsed.data.expectedRevision, owner));
    } catch (error) {
      if (error instanceof OperatorRefusal) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
