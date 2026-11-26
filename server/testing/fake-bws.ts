// A Bitwarden Secrets Manager server in memory, for tests: it encrypts the way the real one answers, with a fresh
// machine account, organization key and access token each time. No network, no real token.
import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";

import { accessTokenKey, type SecretsFetch, type SecretsKey } from "../host/bitwarden-secrets-api.ts";

export interface FakeBwsSecret { id?: string; key: string; value: string; note?: string }

export function encryptForBitwarden(text: string, key: SecretsKey): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.enc, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const mac = createHmac("sha256", key.mac).update(iv).update(data).digest();
  return `2.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** `serverUrl`: what the admin picks; bitwarden.com answers on identity.bitwarden.com and api.bitwarden.com. */
export function fakeBws(options: { secrets: FakeBwsSecret[]; serverUrl?: string }) {
  const id = randomUUID();
  const clientSecret = "fakeClientSecret123";
  const seed = randomBytes(16);
  const organizationId = randomUUID();
  const orgKey = randomBytes(64);
  const key = { enc: orgKey.subarray(0, 32), mac: orgKey.subarray(32) };
  const secrets = options.secrets.map((secret) => ({ ...secret, id: secret.id ?? randomUUID() }));
  const base = options.serverUrl ?? "https://vault.bitwarden.com";
  const cloud = base === "https://vault.bitwarden.com";
  const identity = cloud ? "https://identity.bitwarden.com" : `${base}/identity`;
  const api = cloud ? "https://api.bitwarden.com" : `${base}/api`;
  const bearers = new Set<string>();
  const state = {
    calls: [] as string[],
    /** Answers every request with this status instead. */
    status: null as number | null,
    /** Requests waiting here are held until it resolves. */
    gate: null as Promise<void> | null,
  };
  const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
  const fetch: SecretsFetch = async (url, init) => {
    const path = url.startsWith(identity) ? `identity${url.slice(identity.length)}` : url.startsWith(api) ? `api${url.slice(api.length)}` : url;
    state.calls.push(`${init.method} ${path}`);
    await state.gate;
    if (state.status) return reply(state.status, {});
    if (path === "identity/connect/token") {
      const form = new URLSearchParams(init.body ?? "");
      if (form.get("grant_type") !== "client_credentials" || form.get("scope") !== "api.secrets" || form.get("client_id") !== id || form.get("client_secret") !== clientSecret) {
        return reply(400, { error: "invalid_client" });
      }
      const bearer = `${part({ alg: "none" })}.${part({ organization: organizationId, jti: randomUUID() })}.fake`;
      bearers.add(bearer);
      const payload = encryptForBitwarden(JSON.stringify({ encryptionKey: orgKey.toString("base64") }), accessTokenKey(seed));
      return reply(200, { access_token: bearer, expires_in: 3600, token_type: "Bearer", scope: "api.secrets", encrypted_payload: payload });
    }
    if (!bearers.has(init.headers.authorization?.replace(/^Bearer /u, "") ?? "")) return reply(401, {});
    if (init.method === "GET" && path === `api/organizations/${organizationId}/secrets`) {
      return reply(200, { secrets: secrets.map((secret) => ({ id: secret.id, organizationId, key: encryptForBitwarden(secret.key, key) })), projects: [] });
    }
    if (init.method === "POST" && path === "api/secrets/get-by-ids") {
      const ids = (JSON.parse(init.body ?? "{}") as { ids?: string[] }).ids ?? [];
      const found = secrets.filter((secret) => ids.includes(secret.id));
      // Bitwarden refuses the whole batch when any secret named is gone.
      if (found.length !== new Set(ids).size) return reply(404, {});
      return reply(200, { data: found.map((secret) => ({ id: secret.id, organizationId, key: encryptForBitwarden(secret.key, key),
        value: encryptForBitwarden(secret.value, key), note: encryptForBitwarden(secret.note ?? "", key) })) });
    }
    return reply(404, {});
  };
  return {
    accessToken: `0.${id}.${clientSecret}:${seed.toString("base64")}`,
    /** Same machine account, another seed: Bitwarden accepts it but its key opens nothing. */
    wrongSeed: `0.${id}.${clientSecret}:${randomBytes(16).toString("base64")}`,
    revoked: `0.${randomUUID()}.${clientSecret}:${seed.toString("base64")}`,
    fetch, secrets, state,
    /** Ends every bearer token, as when they expire. */
    expire: () => bearers.clear(),
  };
}
