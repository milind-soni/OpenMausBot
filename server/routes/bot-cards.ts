// The bot credential and connection card HTTP routes (the phone-provided
// secret-card HPKE envelope, the desktop secret-card provided/resume/dismiss
// actions, and the inline connector-card authorize/status/resume/dismiss
// lifecycle), extracted verbatim from index.ts's dispatch chain. Path
// matching, methods, and status codes are unchanged; the handler returns
// false for anything it does not own so the chain falls through in the same
// order. The module's call site sits exactly where the secret-card family
// sat — immediately after the connectors module and immediately before the
// bot computer module — so dispatch order is unchanged. The phone-secret
// envelope schema moved with the family because only these handlers use it;
// the card-state readers, resume helpers and the phone-secret submission
// registry are index-local and cross via deps; cfg/store are live bindings
// from ../runtime.ts and the credential helpers and composio are imported
// from their source modules. index.ts's `return json(...)` statements became
// `json(...); return true;` (json returns void).
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { json, readBody, type RouteContext } from "./http.ts";
import { credentialIsConfigured, credentialResumeOutcome, isCredentialTargetId } from "../../shared/credential-request.ts";
import * as composio from "../composio.ts";
import { cfg, store } from "../runtime.ts";
import { PHONE_SECRET_PROTOCOL_VERSION, type PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { createDeferredResumes } from "../deferred-resumes.ts";
import type { createTurnSecrets } from "../turn-secrets.ts";

type DeferredResumes = ReturnType<typeof createDeferredResumes>;
type TurnSecrets = ReturnType<typeof createTurnSecrets>;

const phoneSecretEnvelopeSchema = z.object({
  version: z.literal(PHONE_SECRET_PROTOCOL_VERSION),
  threadId: z.string().regex(/^[\w-]{1,128}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  target: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  requestKey: z.string().regex(/^[\w-]{1,128}$/),
  encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,5483}$/),
}).strict();

export function createBotCardsRoutes(deps: {
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  phoneSecretSubmissionKey: TurnSecrets["phoneSecretSubmissionKey"];
  currentSecretState: TurnSecrets["currentSecretState"];
  provideSecretFromPhone: TurnSecrets["provideSecretFromPhone"];
  secretMessage: DeferredResumes["secretMessage"];
  resumeSecretCard: DeferredResumes["resumeSecretCard"];
  connectorMessage: DeferredResumes["connectorMessage"];
  maybeResumeConnectors: DeferredResumes["maybeResumeConnectors"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      phoneSecretSubmissions,
      phoneSecretSubmissionKey,
      currentSecretState,
      provideSecretFromPhone,
      secretMessage,
      resumeSecretCard,
      connectorMessage,
      maybeResumeConnectors,
    } = deps;
    // Phone credential entry arrives as an HPKE envelope bound to the exact
    // paired device, bot, task, card and allowlisted target. The companion
    // authenticates the bearer and supplies the device id; only the embedded
    // Electron server has the private key needed to open the envelope.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/provide$/);
    if (m && method === "POST") {
      if (req.headers["x-openmausbot-companion"] !== "1") {
        json(res, 403, { error: "Secure phone entry must come from a paired phone" });
        return true;
      }
      const rawDeviceId = req.headers["x-openmausbot-companion-device"];
      const authenticatedDeviceId = Array.isArray(rawDeviceId) ? "" : String(rawDeviceId ?? "");
      if (!/^[\w-]{1,128}$/.test(authenticatedDeviceId)) {
        json(res, 401, { error: "This paired phone could not be verified" });
        return true;
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const parsed = phoneSecretEnvelopeSchema.safeParse(await readBody(req, 16_384));
      if (!parsed.success || !isCredentialTargetId(parsed.data?.target)) {
        json(res, 400, { error: "The encrypted credential request is invalid" });
        return true;
      }
      const state = await provideSecretFromPhone({
        ...parsed.data,
        botId: m[1],
        messageId: m[2],
        target: parsed.data.target,
      }, authenticatedDeviceId);
      json(res, 200, state);
      return true;
    }

    // Desktop credential cards never send the credential through this route.
    // Electron saves it through the OS-backed store first; these actions only
    // verify configured state, update card metadata, and resume the turn.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/(provided|resume|dismiss)$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const threadId = String(body.threadId ?? "");
      const message = secretMessage(m[1], threadId, m[2]);
      if (!message?.secret) { json(res, 404, { error: "no such credential request" }); return true; }
      if (phoneSecretSubmissions.has(
        phoneSecretSubmissionKey(threadId, message.id, message.secret.requestKey),
      )) {
        json(res, 409, { error: "this credential is currently being saved from a phone" });
        return true;
      }
      if (m[3] === "provided") {
        if (message.secret.dismissed) { json(res, 409, { error: "this credential request was dismissed" }); return true; }
        if (!credentialIsConfigured(cfg, message.secret.target)) {
          json(res, 409, { error: `${message.secret.label} was not saved yet` });
          return true;
        }
        if (!resumeSecretCard(m[1], threadId, message.id, "provided")) {
          json(res, 409, { error: "this credential request is no longer available" });
          return true;
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) { json(res, 409, { error: "this credential request is no longer available" }); return true; }
        json(res, 200, state);
        return true;
      }
      if (m[3] === "resume") {
        const outcome = credentialResumeOutcome(message.secret);
        if (!outcome) {
          json(res, 409, { error: "this credential request is not ready to resume" });
          return true;
        }
        if (outcome === "provided" && !credentialIsConfigured(cfg, message.secret.target)) {
          json(res, 409, { error: `${message.secret.label} is no longer configured` });
          return true;
        }
        if (!resumeSecretCard(m[1], threadId, message.id, outcome)) {
          json(res, 409, { error: "this credential request is no longer available" });
          return true;
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) { json(res, 409, { error: "this credential request is no longer available" }); return true; }
        json(res, 200, { resumed: state.resumed });
        return true;
      }
      if (!message.secret.provided && !resumeSecretCard(m[1], threadId, message.id, "dismissed")) {
        json(res, 409, { error: "this credential request is no longer available" });
        return true;
      }
      const state = currentSecretState(m[1], threadId, message.id);
      if (!state) { json(res, 409, { error: "this credential request is no longer available" }); return true; }
      json(res, 200, { dismissed: true, resumed: state.resumed });
      return true;
    }

    // Inline connection cards are bound to both the bot and the exact task
    // or room thread that created them. The browser auth URL is returned
    // only to this local UI and is never stored in the transcript.
    m = path.match(/^\/api\/bots\/([\w-]+)\/connector-cards\/([\w-]+)\/(authorize|status|resume|dismiss)$/);
    if (m) {
      const body = method === "POST" ? await readBody(req) : {};
      const threadId = String(method === "GET" ? url.searchParams.get("threadId") ?? "" : body.threadId ?? "");
      const message = connectorMessage(m[1], threadId, m[2]);
      if (!message?.connector) { json(res, 404, { error: "no such connection request" }); return true; }
      const connector = message.connector;
      if (m[3] === "authorize" && method === "POST") {
        store.patchMessage(threadId, message.id, {
          connector: { ...connector, status: "authorizing", error: undefined, dismissed: false },
        });
        try {
          json(res, 200, await composio.authorizeService(cfg, connector.slug, connector.alias));
          return true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.patchMessage(threadId, message.id, {
            connector: { ...connector, status: "failed", error: detail.slice(0, 180) },
          });
          throw error;
        }
      }
      if (m[3] === "status" && method === "GET") {
        const service = (await composio.connectionStatus(cfg, [connector.slug]))[connector.slug];
        // A different active account must never complete a second-account card.
        // Missing alias metadata stays pending rather than guessing from the
        // toolkit-wide status (including scoped keys without account reads).
        const account = connector.alias
          ? service?.accounts?.find((item) => item.alias?.trim().toLowerCase() === connector.alias!.toLowerCase())
          : undefined;
        const state = connector.alias ? {
          connected: /^active$/i.test(account?.status ?? ""),
          pending: /^(initiated|initializing|pending)$/i.test(account?.status ?? ""),
          status: account?.status ?? "not_connected",
        } : service;
        const failed = /failed|expired|revoked|error/i.test(state?.status ?? "");
        const next = {
          ...connector,
          status: state?.connected ? ("connected" as const) : failed ? ("failed" as const) : ("authorizing" as const),
          error: failed ? `Connection ${state?.status ?? "failed"}` : undefined,
        };
        store.patchMessage(threadId, message.id, { connector: next });
        if (state?.connected) maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        json(res, 200, { connected: Boolean(state?.connected), pending: Boolean(state?.pending), status: state?.status });
        return true;
      }
      if (m[3] === "resume" && method === "POST") {
        const resumed = maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        if (resumed) {
          json(res, 200, { resumed: true });
          return true;
        }
        json(res, 409, { error: "finish connecting every requested app first" });
        return true;
      }
      if (m[3] === "dismiss" && method === "POST") {
        store.patchMessage(threadId, message.id, { connector: { ...connector, dismissed: true } });
        json(res, 200, { dismissed: true });
        return true;
      }
      json(res, 405, { error: "method not allowed" });
      return true;
    }
    return false;
  };
}
