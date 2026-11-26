// The second transport for closed-app phone push (docs/phone-push.md "Cloud homes"). A Cloud home holds no installation
// credential, so it asks the Admin that runs it, signed with the bootstrap secret it already has (as its wake notice is,
// server/cloud-woke.ts). The Admin checks the signature, takes the machine id from it (never from the body), checks the
// same strict body the control plane does, and forwards it to the control plane's machine routes. The bodies are the
// installation routes' bodies exactly; only the address and the signature differ.
import { createHash, createHmac, randomBytes } from "node:crypto";

import { PHONE_ACTIVITY_RELAY_PATH, PHONE_PUSH_RELAY_PATHS } from "../shared/phone-push.ts";
import { cloudSignedTimestamp } from "./cloud-clock.ts";

/** What a Cloud home signs with: its Admin, its machine id and its bootstrap secret (server/cloud-home.ts). */
export interface CloudHomePushAccess {
  admin: string;
  machineId: string;
  secret: string;
}

/** Each control-plane installation route, and the Admin route that relays it for a Cloud home. */
export const CLOUD_HOME_PUSH_ACTIONS: Readonly<Record<string, "register" | "unregister" | "send" | "activity">> = {
  [PHONE_PUSH_RELAY_PATHS.register]: "register",
  [PHONE_PUSH_RELAY_PATHS.unregister]: "unregister",
  [PHONE_PUSH_RELAY_PATHS.send]: "send",
  [PHONE_ACTIVITY_RELAY_PATH]: "activity",
};
export const CLOUD_HOME_PUSH_ADMIN_PATH = "/api/cloud/machines/push/";

/** Must match the Admin's `cloudHomePushSignature` (openmaus-cloud server/cloud-push.ts): the action is signed, so a
 * request signed for one route is never accepted by another. */
export function cloudHomePushSignature(secret: string, machineId: string, action: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`omb-phone-push-v1\n${machineId}\n${action}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

/** The access a Cloud home has, or null when this server is not one. */
export function cloudHomePushAccess(home: { adminOrigin: string; machineId: string; bootstrapSecret: string } | null | undefined): CloudHomePushAccess | null {
  if (!home?.adminOrigin || !home.machineId || !home.bootstrapSecret) return null;
  return { admin: home.adminOrigin.replace(/\/+$/, ""), machineId: home.machineId, secret: home.bootstrapSecret };
}

/** The Admin request for one relay call, or null for a path the Admin does not relay. The secret never leaves this
 * process: only the signature does. */
export function cloudHomePushRequest(access: CloudHomePushAccess, path: string, body: unknown, now: number): { url: string; init: RequestInit } | null {
  const action = CLOUD_HOME_PUSH_ACTIONS[path];
  if (!action) return null;
  const raw = JSON.stringify(body);
  const timestamp = cloudSignedTimestamp(now), nonce = randomBytes(18).toString("base64url");
  return {
    url: `${access.admin}${CLOUD_HOME_PUSH_ADMIN_PATH}${action}`,
    init: {
      method: "POST",
      body: raw,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-omb-cloud-machine": access.machineId,
        "x-omb-cloud-timestamp": timestamp,
        "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${cloudHomePushSignature(access.secret, access.machineId, action, timestamp, nonce, raw)}`,
      },
    },
  };
}
