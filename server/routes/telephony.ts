// Telephony inside the app: the SMS and call records every channel shares, and the
// outbound triggers. An outbound call or text reaches a person outside the app, so
// "ask" (the default) refuses one without an explicit approval from the person.
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import { configured, loadTelephonyConfig, placeCall, sendSms, type TelephonyConfig } from "../telephony/service.ts";
import { openTelephonyStore, telephonyStoreFile, type TelephonyStore } from "../telephony/store.ts";

export interface TelephonyRouteDeps {
  store: TelephonyStore;
  config(): TelephonyConfig;
  /** "ask": outbound SMS and calls need approved: true. "allow": they go out on request. */
  outboundPolicy?(): "ask" | "allow";
  fetch?: typeof fetch;
}

export function createTelephonyRoutes(deps: TelephonyRouteDeps): RouteHandler {
  const policy = deps.outboundPolicy ?? (() => ((process.env.TELEPHONY_OUTBOUND_POLICY?.trim() || "ask") === "allow" ? "allow" : "ask"));
  const fetcher = deps.fetch ?? fetch;

  return async ({ req, res, path, method, json, readBody }: RouteContext) => {
    if (!path.startsWith("/api/telephony/")) return PASS;
    const config = deps.config();

    if (method === "GET" && path === "/api/telephony/status") {
      return json(res, 200, {
        configured: configured(config),
        botPhoneNumber: config.botPhoneNumber || null,
        ownerConfigured: Boolean(config.ownerPhoneNumber),
        publicUrl: config.publicUrl ?? null,
        livekitSipUri: config.livekitSipUri ?? null,
        outboundPolicy: policy(),
        storeFile: deps.store.file,
      });
    }

    if (method === "GET" && path === "/api/telephony/sms") {
      return json(res, 200, { messages: deps.store.listSms() });
    }
    if (method === "GET" && path === "/api/telephony/calls") {
      return json(res, 200, { calls: deps.store.listCalls() });
    }
    if (method === "GET" && path === "/api/telephony/memory") {
      return json(res, 200, { facts: deps.store.facts() });
    }

    if (method === "POST" && (path === "/api/telephony/sms/outbound" || path === "/api/telephony/sms/approve")) {
      const body = (await readBody(req)) as { to?: string; body?: string; smsId?: string; approved?: boolean };
      // Approving a drafted reply is itself the approval; a fresh outbound SMS is not.
      const gate = path === "/api/telephony/sms/approve" || policy() === "allow" || body.approved === true;
      if (!gate) {
        return json(res, 403, { error: "An outbound SMS needs approval. Send approved: true once the person has agreed." });
      }
      let to = body.to;
      let text = body.body;
      if (!to && body.smsId) {
        const inbound = deps.store.listSms(500).find((sms) => sms.id === body.smsId);
        if (!inbound) return json(res, 404, { error: "No such SMS to approve." });
        to = inbound.from;
        text = text ?? inbound.proposedReply;
      }
      if (!to || !text?.trim()) return json(res, 400, { error: "Missing fields: to (or smsId) and body" });
      const result = await sendSms(config, { to, body: text }, fetcher);
      if (!result.ok) return json(res, 502, { error: result.error });
      const sent = deps.store.appendSms({
        direction: "out",
        from: config.botPhoneNumber,
        to,
        body: text,
        at: Date.now(),
        status: "sent",
        ...(body.smsId ? { replyTo: body.smsId } : {}),
      });
      if (body.smsId) deps.store.patchSms(body.smsId, { status: "sent", proposedReply: undefined });
      return json(res, 200, { sid: result.sid, sms: sent });
    }

    if (method === "POST" && path === "/api/telephony/sms/reject") {
      const body = (await readBody(req)) as { smsId?: string };
      if (!body?.smsId) return json(res, 400, { error: "Missing required field: smsId" });
      const rejected = deps.store.patchSms(body.smsId, { status: "ignored", proposedReply: undefined });
      if (!rejected) return json(res, 404, { error: "No such SMS." });
      return json(res, 200, { sms: rejected });
    }

    if (method === "POST" && path === "/api/telephony/calls/outbound") {
      const body = (await readBody(req)) as { to?: string; objective?: string; approved?: boolean };
      if (!(policy() === "allow" || body.approved === true)) {
        return json(res, 403, { error: "An outbound call needs approval. Send approved: true once the person has agreed." });
      }
      if (!body?.to || !body?.objective) {
        return json(res, 400, { error: "Missing required fields: to, objective" });
      }
      const result = await placeCall(config, { to: body.to, objective: body.objective }, fetcher);
      if (!result.ok) return json(res, 502, { error: result.error });
      const call = deps.store.appendCall({
        direction: "out",
        from: config.botPhoneNumber,
        to: body.to,
        at: Date.now(),
        status: "ringing",
        objective: body.objective,
      });
      return json(res, 200, { sid: result.sid, call });
    }

    return PASS;
  };
}

/**
 * The one wiring behind every telephony surface: a single store instance shared by these
 * routes, the public Twilio door and the voice worker's ingest, so a draft written by the
 * door is the draft these routes approve.
 */
export interface TelephonyWiring {
  store: TelephonyStore;
  config(): TelephonyConfig;
}

let wiring: TelephonyWiring | undefined;

export function telephonyWiring(): TelephonyWiring {
  wiring ??= { store: openTelephonyStore(telephonyStoreFile()), config: loadTelephonyConfig };
  return wiring;
}

/** The handler index.ts routes: the shared wiring with the env's outbound gate. */
export const telephonyRoutes: RouteHandler = (ctx) => createTelephonyRoutes(telephonyWiring())(ctx);