import { userError } from "../user-errors.ts";
// POST /api/bots/<bot>/secret-cards/<message>/provide with a phone's sealed envelope, .../save with {threadId, value}
// for a custom secret typed in the app, .../use with {threadId, itemId} for one picked from the Vault (GET .../saved
// lists those by name), and .../(provided|resume|dismiss) with {threadId}; and the agents tool's
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
function codedSecretAnswerRefusal(auth: RequestAuth, context: SecretAnswerContext): { error: string } | null {
  if (auth.kind === "loopback") return auth.trust === "service" ? userError("serverError.secret.localService") : null;
  const admin = auth.scopes.includes("admin");
  if (context.personalCloud) return admin ? null : userError("serverError.secret.cloudOwnerOnly");
  if (!context.shared) return null;
  if (context.owner) return context.owner === context.person ? null : userError("serverError.secret.conversationOwnerOnly");
  return admin ? null : { error: "Only a workspace admin can enter this secret." };
}

export function secretAnswerRefusal(auth: RequestAuth, context: SecretAnswerContext): string | null {
  return codedSecretAnswerRefusal(auth, context)?.error ?? null;
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
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null;
    // Picking a saved secret lets the bot use it, so these are an admin's (not in CLIENT_ALLOW) like the Vault itself.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/(saved|use)$/);
    if (m && method === (m[3] === "saved" ? "GET" : "POST")) {
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (m[3] === "use" && mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      const raw = m[3] === "use" ? await readBody(req, 16_384) : null;
      const fields = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const threadId = m[3] === "saved" ? url.searchParams.get("threadId") ?? "" : String(fields.threadId ?? "");
      if (!deps.threadVisible(auth, threadId) || !secretMessage(m[1]!, threadId, m[2]!)) return json(res, 404, { ...userError("serverError.secret.missing") });
      const refusal = codedSecretAnswerRefusal(auth, deps.answerContext(auth, m[1]!, threadId));
      if (refusal) return json(res, 403, refusal);
      res.setHeader("cache-control", "no-store");
      if (m[3] === "saved") return json(res, 200, { choices: deps.cards.savedChoices(m[1]!, threadId, m[2]!) });
      const result = await deps.cards.useSavedSecret(m[1]!, threadId, m[2]!, fields.itemId);
      return json(res, result.status, result.body);
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/save$/);
    if (m && method === "POST") {
      // JSON only, so a form posted from another local page cannot save one.
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      const raw = await readBody(req, SECRET_VALUE_MAX_BYTES * 4);
      const fields = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const threadId = String(fields.threadId ?? "");
      if (!deps.threadVisible(auth, threadId) || !secretMessage(m[1]!, threadId, m[2]!)) return json(res, 404, { ...userError("serverError.secret.missing") });
      const refusal = codedSecretAnswerRefusal(auth, deps.answerContext(auth, m[1]!, threadId));
      if (refusal) return json(res, 403, refusal);
      const result = secretMessage(m[1]!, threadId, m[2]!)?.secret?.delivery === "email"
        ? await deps.cards.saveEmailSecret(m[1]!, threadId, m[2]!, fields)
        : deps.cards.saveCustomSecret(m[1]!, threadId, m[2]!, fields.value);
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
        const refusal = codedSecretAnswerRefusal(auth, deps.answerContext(auth, m[1], parsed.data.threadId));
        if (refusal) return json(res, 403, refusal);
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
      if (!message?.secret) return json(res, 404, { ...userError("serverError.secret.missing") });
      if (phoneSecretSubmissions.has(
        phoneSecretSubmissionKey(threadId, message.id, message.secret.requestKey),
      )) {
        return json(res, 409, { ...userError("serverError.secret.credentialSavingFromPhone") });
      }
      if (m[3] === "provided") {
        if (message.secret.dismissed) return json(res, 409, { ...userError("serverError.secret.credentialDismissed") });
        if (message.secret.superseded) return json(res, 409, { ...userError("serverError.secret.credentialSuperseded") });
        if (!secretSaved(message.secret)) {
          return json(res, 409, { ...userError("serverError.secret.notSavedYet", { label: message.secret.label }) });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, "provided")) {
          return json(res, 409, { ...userError("serverError.secret.unavailableLower") });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { ...userError("serverError.secret.unavailableLower") });
        return json(res, 200, state);
      }
      if (m[3] === "resume") {
        if (message.secret.superseded) return json(res, 409, { ...userError("serverError.secret.credentialSuperseded") });
        const outcome = credentialResumeOutcome(message.secret);
        if (!outcome) {
          return json(res, 409, { ...userError("serverError.secret.notReadyToResume") });
        }
        if (outcome === "provided" && !secretSaved(message.secret)) {
          return json(res, 409, { ...userError("serverError.secret.noLongerConfigured", { label: message.secret.label }) });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, outcome)) {
          return json(res, 409, { ...userError("serverError.secret.unavailableLower") });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { ...userError("serverError.secret.unavailableLower") });
        return json(res, 200, { resumed: state.resumed });
      }
      if (message.secret.superseded) return json(res, 409, { ...userError("serverError.secret.credentialSuperseded") });
      if (!message.secret.provided && !resumeSecretCard(m[1], threadId, message.id, "dismissed")) {
        return json(res, 409, { ...userError("serverError.secret.unavailableLower") });
      }
      const state = currentSecretState(m[1], threadId, message.id);
      if (!state) return json(res, 409, { ...userError("serverError.secret.unavailableLower") });
      return json(res, 200, { dismissed: true, resumed: state.resumed });
    }
    return PASS;
  };
}

/** Only dispatch inside the internal capability gate, with its guarded body reader. The global route table must never
 * register this endpoint. */
export function createInternalCredentialRequestRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  request(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/request-credential") return PASS;
    const result = await deps.request(await deps.readBody());
    return json(res, result.status, result.body);
  };
}
