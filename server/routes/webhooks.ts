// The webhook management HTTP routes, extracted verbatim from index.ts's
// dispatch chain. Path matching, methods, and status codes are unchanged;
// the handler returns false for anything it does not own so the chain falls
// through in the same order.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { webhookCredential } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";

export function createWebhookRoutes(deps: {
  webhooks: WebhookManager;
  webhookIngressStatus: () => { available: boolean; baseUrl: string; error?: string };
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path } = rctx;
    const { webhooks, webhookIngressStatus } = deps;
    // ── independent webhook triggers ────────────────────────────────────
    // Management stays on the app-only server. Actual deliveries land on a
    // second, webhook-only loopback listener so Funnel or a future hosted
    // relay never has to expose the rest of OpenMausBot's control surface.
    if (path === "/api/webhooks" && method === "GET") {
      json(res, 200, { webhooks: webhooks.list(), attempts: webhooks.listAttempts(), ingress: webhookIngressStatus() });
      return true;
    }
    if (path === "/api/webhooks" && method === "POST") {
      const created = webhooks.create(await readBody(req));
      const ingress = webhookIngressStatus();
      json(res, 201, {
        webhook: created.webhook,
        ingress,
        credential: webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret),
      });
      return true;
    }
    let webhookMatch = path.match(/^\/api\/webhooks\/([\w-]+)\/(rotate|test)$/);
    if (webhookMatch && method === "POST") {
      if (webhookMatch[2] === "test") {
        const result = webhooks.test(webhookMatch[1], await readBody(req));
        if (result) json(res, 202, result);
        else json(res, 404, { error: "no such webhook" });
        return true;
      }
      const rotated = webhooks.rotateSecret(webhookMatch[1]);
      if (!rotated) {
        json(res, 404, { error: "no such webhook" });
        return true;
      }
      const ingress = webhookIngressStatus();
      json(res, 200, {
        webhook: rotated.webhook,
        ingress,
        credential: webhookCredential(ingress.baseUrl, rotated.webhook.endpointId, rotated.secret),
      });
      return true;
    }
    webhookMatch = path.match(/^\/api\/webhooks\/([\w-]+)$/);
    if (webhookMatch && method === "PATCH") {
      const webhook = webhooks.update(webhookMatch[1], await readBody(req));
      if (webhook) json(res, 200, { webhook });
      else json(res, 404, { error: "no such webhook" });
      return true;
    }
    if (webhookMatch && method === "DELETE") {
      if (webhooks.remove(webhookMatch[1])) {
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: "no such webhook" });
      }
      return true;
    }
    return false;
  };
}
