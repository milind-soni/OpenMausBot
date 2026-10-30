// POST /api/bots/<bot>/secret-cards/<message>/provide with a phone's sealed envelope, .../save with {threadId, value}
// for a custom secret typed in the app, and .../(provided|resume|dismiss) with {threadId}; and the agents tool's
// /api/internal/request-credential. A value is never echoed back, logged or added to the card.
import { CUSTOM_SECRET_TARGET, credentialResumeOutcome, isCredentialTargetId } from "../../shared/credential-request.ts";
import { phoneSecretEnvelopeSchema, type SecretCards } from "../host/secret-cards.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { RequestAuth } from "../request-auth.ts";
import { SECRET_VALUE_MAX_BYTES } from "../secret-vault.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** Whose a conversation is, for who may type a secret into its card. */
export interface SecretAnswerContext {
  /** A Cloud only its owner answers: any other session is a guest. */
  personalCloud: boolean;
  /** Other people sign in here too (a Team Cloud, or a server with members). */
  shared: boolean;
  /** The person the conversation belongs to, when it names one. */
  owner: string | null;
  /** The person this session is. */
  person: string | null;
}

/** Stricter than an ordinary card: only the conversation's own person, never another member or an admin on their behalf. */
export function secretAnswerRefusal(auth: RequestAuth, context: SecretAnswerContext): string | null {
  if (auth.kind === "loopback") return auth.trust === "service" ? "A local service cannot enter a secret. Enter it in OpenMausBot." : null;
  const admin = auth.scopes.includes("admin");
  if (context.personalCloud) return admin ? null : "Only the owner of this Cloud can enter this secret.";
  if (!context.shared) return null;
  if (context.owner) return context.owner === context.person ? null : "Only the person this conversation belongs to can enter this secret.";
  return admin ? null : "Only a workspace admin can enter this secret.";
}

export interface SecretCardRouteDeps {
  cards: SecretCards;
  phoneSecretSubmissions: Pick<PhoneSecretSubmissionRegistry, "has">;
  /** A member reaches a card only in a thread shown to them. */
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  answerContext(auth: RequestAuth, botId: string, threadId: string): SecretAnswerContext;
}

export function createSecretCardRoutes(deps: SecretCardRouteDeps): RouteHandler {
  const { phoneSecretSubmissions } = deps;
  const { secretMessage, currentSecretState, resumeSecretCard, provideSecretFromPhone, phoneSecretSubmissionKey, secretSaved } = deps.cards;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null;
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/save$/);
    if (m && method === "POST") {
      // JSON only, so a form posted from another local page cannot save one.
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      const raw = await readBody(req, SECRET_VALUE_MAX_BYTES * 4);
      const fields = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const threadId = String(fields.threadId ?? "");
      if (!deps.threadVisible(auth, threadId) || !secretMessage(m[1]!, threadId, m[2]!)) return json(res, 404, { error: "no such credential request" });
      const refusal = secretAnswerRefusal(auth, deps.answerContext(auth, m[1]!, threadId));
      if (refusal) return json(res, 403, { error: refusal });
      const result = deps.cards.saveCustomSecret(m[1]!, threadId, m[2]!, fields.value);
      return json(res, result.status, result.body);
    }
    // An HPKE envelope bound to the paired device, bot, task, card and target; only the embedded Electron server holds the key to open it.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/provide$/);
    if (m && method === "POST") {
      if (req.headers["x-openmausbot-companion"] !== "1") {
        return json(res, 403, { error: "Secure phone entry must come from a paired phone" });
      }
      const rawDeviceId = req.headers["x-openmausbot-companion-device"];
      const authenticatedDeviceId = Array.isArray(rawDeviceId) ? "" : String(rawDeviceId ?? "");
      if (!/^[\w-]{1,128}$/.test(authenticatedDeviceId)) {
        return json(res, 401, { error: "This paired phone could not be verified" });
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = phoneSecretEnvelopeSchema.safeParse(await readBody(req, 16_384));
      if (!parsed.success || (!isCredentialTargetId(parsed.data?.target) && parsed.data?.target !== CUSTOM_SECRET_TARGET)) {
        return json(res, 400, { error: "The encrypted credential request is invalid" });
      }
      if (parsed.data.target === CUSTOM_SECRET_TARGET) {
        const refusal = secretAnswerRefusal(auth, deps.answerContext(auth, m[1], parsed.data.threadId));
        if (refusal) return json(res, 403, { error: refusal });
      }
      const state = await provideSecretFromPhone({
        ...parsed.data,
        botId: m[1],
        messageId: m[2],
        target: parsed.data.target,
      }, authenticatedDeviceId);
      return json(res, 200, state);
    }

    // Desktop credential cards never send the credential through this route: Electron saves it to the OS-backed store first.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/(provided|resume|dismiss)$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const threadId = String(body.threadId ?? "");
      const message = secretMessage(m[1], threadId, m[2]);
      if (!message?.secret) return json(res, 404, { error: "no such credential request" });
      if (phoneSecretSubmissions.has(
        phoneSecretSubmissionKey(threadId, message.id, message.secret.requestKey),
      )) {
        return json(res, 409, { error: "this credential is currently being saved from a phone" });
      }
      if (m[3] === "provided") {
        if (message.secret.dismissed) return json(res, 409, { error: "this credential request was dismissed" });
        if (message.secret.superseded) return json(res, 409, { error: "this credential request was superseded by a newer one" });
        if (!secretSaved(message.secret)) {
          return json(res, 409, { error: `${message.secret.label} was not saved yet` });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, "provided")) {
          return json(res, 409, { error: "this credential request is no longer available" });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { error: "this credential request is no longer available" });
        return json(res, 200, state);
      }
      if (m[3] === "resume") {
        if (message.secret.superseded) return json(res, 409, { error: "this credential request was superseded by a newer one" });
        const outcome = credentialResumeOutcome(message.secret);
        if (!outcome) {
          return json(res, 409, { error: "this credential request is not ready to resume" });
        }
        if (outcome === "provided" && !secretSaved(message.secret)) {
          return json(res, 409, { error: `${message.secret.label} is no longer configured` });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, outcome)) {
          return json(res, 409, { error: "this credential request is no longer available" });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { error: "this credential request is no longer available" });
        return json(res, 200, { resumed: state.resumed });
      }
      if (message.secret.superseded) return json(res, 409, { error: "this credential request was superseded by a newer one" });
      if (!message.secret.provided && !resumeSecretCard(m[1], threadId, message.id, "dismissed")) {
        return json(res, 409, { error: "this credential request is no longer available" });
      }
      const state = currentSecretState(m[1], threadId, message.id);
      if (!state) return json(res, 409, { error: "this credential request is no longer available" });
      return json(res, 200, { dismissed: true, resumed: state.resumed });
    }
    return PASS;
  };
}

/** Only dispatch inside the internal capability gate, with its guarded body reader. The global route table must never
 * register this endpoint. */
export function createInternalCredentialRequestRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  request(body: Record<string, unknown>): { status: number; body: Record<string, unknown> };
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/request-credential") return PASS;
    const result = deps.request(await deps.readBody());
    return json(res, result.status, result.body);
  };
}
