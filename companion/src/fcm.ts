/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns,
 * anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof
 * -- Firebase's signed HTTP responses and service-account JSON cross this
 * boundary as untrusted records; validation is intentionally local to the
 * narrow credential/response helpers below. */
import { createSign } from "node:crypto";

export interface FirebaseCredential {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface PushNotification {
  id: string;
  kind: "approval" | "question" | "done" | "routine-failed" | "takeover";
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  avatarUrl?: string;
}

export type FcmSendResult =
  | { kind: "delivered" }
  | { kind: "invalid-target" }
  | { kind: "retryable"; error: string }
  | { kind: "disabled"; error: string };

interface FcmSenderOptions {
  credential: string | undefined;
  projectId: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;

const stringField = (value: Record<string, unknown>, key: string): string | null =>
  typeof value[key] === "string" ? value[key] : null;

export function parseFirebaseCredential(raw: string | undefined, expectedProjectId: string): FirebaseCredential | null {
  if (!raw || !expectedProjectId) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const object = objectValue(parsed);
  if (!object || object.type !== "service_account") return null;
  const projectId = stringField(object, "project_id");
  const clientEmail = stringField(object, "client_email");
  const privateKey = stringField(object, "private_key");
  const tokenUri = stringField(object, "token_uri");
  if (
    projectId !== expectedProjectId ||
    !clientEmail?.endsWith(".iam.gserviceaccount.com") ||
    !privateKey?.includes("BEGIN PRIVATE KEY") ||
    tokenUri !== "https://oauth2.googleapis.com/token"
  ) {
    return null;
  }
  return { projectId, clientEmail, privateKey, tokenUri };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function serviceAccountAssertion(credential: FirebaseCredential, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credential.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: credential.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credential.privateKey).toString("base64url")}`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function includesErrorCode(value: unknown, code: string): boolean {
  if (Array.isArray(value)) return value.some((item) => includesErrorCode(item, code));
  const object = objectValue(value);
  if (!object) return false;
  if (object.errorCode === code) return true;
  return Object.values(object).some((item) => includesErrorCode(item, code));
}

export function createFcmSender(options: FcmSenderOptions) {
  const credential = parseFirebaseCredential(options.credential, options.projectId);
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let tokenCache: TokenCache | null = null;
  let tokenRequest: Promise<TokenCache | null> | null = null;

  const accessToken = async (): Promise<TokenCache | null> => {
    if (!credential) return null;
    if (tokenCache && tokenCache.expiresAt - 60_000 > now()) return tokenCache;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      try {
        const response = await request(credential.tokenUri, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: serviceAccountAssertion(credential, now()),
          }),
        });
        const body = objectValue(await responseJson(response));
        const value = body && stringField(body, "access_token");
        const expiresIn = body?.expires_in;
        if (!response.ok || !value || typeof expiresIn !== "number" || expiresIn <= 0) return null;
        tokenCache = { value, expiresAt: now() + expiresIn * 1000 };
        return tokenCache;
      } catch {
        return null;
      } finally {
        tokenRequest = null;
      }
    })();
    return tokenRequest;
  };

  return {
    enabled: credential !== null,
    async send(target: string, notification: PushNotification): Promise<FcmSendResult> {
      if (!credential) return { kind: "disabled", error: "Firebase credentials are not configured" };
      const bearer = await accessToken();
      if (!bearer) return { kind: "retryable", error: "could not authenticate with Firebase" };
      try {
        const response = await request(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(credential.projectId)}/messages:send`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer.value}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token: target,
                data: {
                  id: notification.id,
                  kind: notification.kind,
                  botId: notification.botId,
                  botName: notification.botName,
                  threadId: notification.threadId,
                  title: notification.title,
                  body: notification.body,
                  avatarUrl: notification.avatarUrl ?? "",
                },
                android: { priority: "high" },
              },
            }),
          },
        );
        if (response.ok) return { kind: "delivered" };
        const body = await responseJson(response);
        if (response.status === 404 || includesErrorCode(body, "UNREGISTERED")) return { kind: "invalid-target" };
        if (response.status === 401) tokenCache = null;
        return { kind: "retryable", error: `Firebase returned HTTP ${response.status}` };
      } catch (error) {
        return { kind: "retryable", error: error instanceof Error ? error.message : "Firebase request failed" };
      }
    },
  };
}
