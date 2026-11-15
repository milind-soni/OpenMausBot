// The person's side of webhook automations. Deliveries land on a separate webhook-only loopback listener, so a relay never
// exposes the rest of the control surface. Only the list is a client route; the rest, the address included, needs admin.
import { canManageWebhook, webhookVisible } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { webhookCredential } from "../webhook-ingress.ts";
import type { WebhookActor, WebhookManager } from "../webhooks.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface WebhookVisibility {
  everything: boolean;
  bot(id: string): boolean;
  group(id: string): boolean;
  level?(id: string): string;
  member?: boolean;
}

export interface WebhookRouteDeps {
  webhooks: WebhookManager;
  ingress: () => { available: boolean; baseUrl: string; error?: string };
  visible: (auth: RequestAuth) => WebhookVisibility;
}

export function createWebhookRoutes({ webhooks, ingress, visible }: WebhookRouteDeps): RouteHandler {
  const withCredential = (webhook: { endpointId: string }, secret: string) => {
    const status = ingress();
    return { ingress: status, credential: webhookCredential(status.baseUrl, webhook.endpointId, secret) };
  };
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext) => {
    const seen = visible(auth);
    const actor: WebhookActor = {
      canSee: (target) => webhookVisible(target, seen),
      canManage: (target) => canManageWebhook(target, seen),
    };

    if (path === "/api/webhooks" && method === "GET") {
      const shownHooks = webhooks.list().filter((webhook) => webhookVisible(webhook, seen));
      const shownIds = new Set(shownHooks.map((webhook) => webhook.id));
      return json(res, 200, { webhooks: shownHooks, attempts: webhooks.listAttempts().filter((attempt) => seen.everything || shownIds.has(attempt.webhookId)), ingress: ingress() });
    }
    if (path === "/api/webhooks" && method === "POST") {
      try {
        const body = await readBody(req);
        const created = webhooks.create(actor, body);
        return json(res, 201, { webhook: created.webhook, ...withCredential(created.webhook, created.secret) });
      } catch (error) {
        const status = (error as { status?: number })?.status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const match = path.match(/^\/api\/webhooks\/([\w-]+)(?:\/(rotate|test|address))?$/);
    if (!match) return PASS;
    const id = match[1]!;

    const existing = webhooks.get(id);
    if (!existing || !webhookVisible(existing, seen)) {
      return json(res, 404, { error: "no such webhook" });
    }

    // The address as it is now, which the owning bot may already have given an app: reading it never replaces it.
    if (match[2] === "address" && method === "GET") {
      const current = webhooks.currentSecret(id, false);
      if (!current || !webhookVisible(current.webhook, seen)) return json(res, 404, { error: "no such webhook" });
      if (!current.secret) return json(res, 404, { error: "this address was made before addresses were kept", kept: false });
      return json(res, 200, { webhook: current.webhook, ...withCredential(current.webhook, current.secret) });
    }

    if (!canManageWebhook(existing, seen)) {
      return json(res, 403, { error: "cannot manage this webhook" });
    }

    if (match[2] === "test" && method === "POST") {
      try {
        const result = webhooks.test(actor, id, await readBody(req));
        return result ? json(res, 202, result) : json(res, 404, { error: "no such webhook" });
      } catch (error) {
        const status = (error as { status?: number })?.status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (match[2] === "rotate" && method === "POST") {
      try {
        const rotated = webhooks.rotateSecret(actor, id);
        return rotated ? json(res, 200, { webhook: rotated.webhook, ...withCredential(rotated.webhook, rotated.secret) }) : json(res, 404, { error: "no such webhook" });
      } catch (error) {
        const status = (error as { status?: number })?.status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!match[2] && method === "PATCH") {
      try {
        const webhook = webhooks.update(actor, id, await readBody(req));
        return webhook ? json(res, 200, { webhook }) : json(res, 404, { error: "no such webhook" });
      } catch (error) {
        const status = (error as { status?: number })?.status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!match[2] && method === "DELETE") {
      try {
        return webhooks.remove(actor, id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such webhook" });
      } catch (error) {
        const status = (error as { status?: number })?.status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return PASS;
  };
}
