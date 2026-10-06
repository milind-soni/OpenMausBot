import { z } from "zod";
import { PASS, type RouteHandler } from "./table.ts";
import type { TrustedContacts } from "../trusted-contacts.ts";
import { contactErrorResponse, receiveContactText, type TrustedPeers } from "../trusted-contacts-http.ts";

export interface TrustedContactRouteDeps {
  contacts: TrustedContacts; peers: TrustedPeers;
  ingress(): { available: boolean; baseUrl: string };
  messaging(): unknown;
}
export function createTrustedContactRoutes(deps: TrustedContactRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/trusted-contacts" && !path.startsWith("/api/trusted-contacts/")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin") || (auth.kind === "loopback" && auth.trust === "service")) return json(res, 403, { error: "Only the workspace owner or an admin may manage trusted contacts" });
    const root = "/api/trusted-contacts";
    try {
      if (path === root && method === "GET") return json(res, 200, { ...deps.contacts.snapshot(), peers: deps.peers.snapshot(), ingress: deps.ingress(), messaging: deps.messaging() });
      if (path === `${root}/contacts` && method === "POST") return json(res, 201, deps.contacts.createContact(await readBody(req, 16000)));
      if (path === `${root}/calendar` && method === "PUT") { deps.contacts.configure(await readBody(req, 32000)); return json(res, 200, { ok: true }); }
      let match = new RegExp(`^${root}/contacts/([\\w-]+)/(grant|revoke|disable|rotate)$`).exec(path);
      if (match && method === "POST") {
        const [, id, action] = match;
        if (action === "grant") deps.contacts.grant(id!, await readBody(req, 16000));
        else if (action === "rotate") return json(res, 200, { token: deps.contacts.rotate(id!) });
        else deps.contacts.revoke(id!, action === "disable");
        return json(res, 200, { ok: true });
      }
      if (path === `${root}/simulate` && method === "POST") {
        const body = z.object({ contactId: z.string().uuid(), id: z.string().regex(/^[\w-]{1,100}$/), text: z.string().min(1).max(4000) }).strict().parse(await readBody(req, 16000));
        return json(res, 200, { text: await receiveContactText(deps.contacts, body.contactId, body.id, body.text) });
      }
      match = new RegExp(`^${root}/requests/([\\w-]+)/(decision|invitation)$`).exec(path);
      if (match?.[2] === "decision" && method === "POST") {
        const body = z.object({ decision: z.enum(["approve", "deny"]) }).strict().parse(await readBody(req, 1000));
        return json(res, 200, await deps.contacts.decide(match[1]!, body.decision));
      }
      if (match?.[2] === "invitation" && method === "GET") {
        const calendar = deps.contacts.invitation(match[1]!);
        res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="meeting.ics"' }); res.end(calendar); return;
      }
      if (path === `${root}/peers` && method === "POST") return json(res, 201, deps.peers.add(await readBody(req, 16000)));
      match = new RegExp(`^${root}/peers/([\\w-]+)$`).exec(path);
      if (match && method === "DELETE") { deps.peers.remove(match[1]!); return json(res, 200, { ok: true }); }
      match = new RegExp(`^${root}/peers/([\\w-]+)/requests$`).exec(path);
      if (match && method === "POST") return json(res, 200, await deps.peers.send(match[1]!, await readBody(req, 16000)));
      match = new RegExp(`^${root}/outbound/([\\w-]+)/refresh$`).exec(path);
      if (match && method === "POST") return json(res, 200, await deps.peers.refresh(match[1]!));
      return json(res, 404, { error: "Unknown trusted-contact operation" });
    } catch (error) { contactErrorResponse(res, error); }
  };
}
