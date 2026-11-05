// POST /api/phone-move/key: a key a phone ticked to bring under its move grant, sealed for this computer. Only the
// phone-secret bridge opens it, and only after the grant, the phone and the slot are checked; the value is never echoed or logged.
import { credentialIsConfigured, isCredentialTargetId, type CredentialConfig } from "../../shared/credential-request.ts";
import { phoneSecretEnvelopeSchema } from "../host/secret-cards.ts";
import { PhoneSecretError, type PhoneSecretBridge } from "../phone-secret.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const moveKeySchema = phoneSecretEnvelopeSchema.omit({ threadId: true });

export interface PhoneMoveKeyDeps {
  moving(auth: RequestAuth): string | null;
  keys: Pick<PhoneSecretBridge, "provideMoveKey">;
  config(): CredentialConfig;
}

export function createPhoneMoveKeyRoutes(deps: PhoneMoveKeyDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method !== "POST" || path !== "/api/phone-move/key") return PASS;
    const phone = deps.moving(auth);
    if (!phone) return json(res, 403, { error: "Allow this move on the computer first." });
    const parsed = moveKeySchema.safeParse(await readBody(req, 16_384));
    if (!parsed.success) return json(res, 400, { error: "The encrypted key is invalid" });
    const envelope = parsed.data;
    if (envelope.deviceId !== phone) return json(res, 403, { error: "This encrypted key belongs to another phone." });
    if (!isCredentialTargetId(envelope.target) || envelope.target === "onePasswordToken") return json(res, 400, { error: "Add this key on the computer." });
    // A moved key never replaces the computer's own, and is not even opened then.
    if (credentialIsConfigured(deps.config(), envelope.target)) return json(res, 200, { v: 1, saved: false, kept: true });
    try {
      await deps.keys.provideMoveKey(envelope);
    } catch (error) {
      if (error instanceof PhoneSecretError) return json(res, error.status, { error: error.message });
      throw error;
    }
    return json(res, 200, { v: 1, saved: true });
  };
}
