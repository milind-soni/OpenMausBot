// Bitwarden Secrets Manager through its public HTTP API, written for OpenMausBot: no code or package from Bitwarden's
// SDK or its `bws` tool (both under the Bitwarden SDK License), so OpenMausBot stays Apache-2.0.
import { createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { BITWARDEN_SERVERS } from "../../shared/logins.ts";

/** A Bitwarden symmetric key: AES-256-CBC for the text, HMAC-SHA256 over iv and text. */
export interface SecretsKey { enc: Buffer; mac: Buffer }

/** A machine account's access token, `0.<id>.<client secret>:<base64 16-byte seed>`, with the key its seed derives. */
export interface AccessToken { id: string; clientSecret: string; key: SecretsKey }

export interface SecretsServer { identity: string; api: string }

export interface SecretName { id: string; name: string }
export interface SecretValue { id: string; name: string; value: string; note: string }

/** `refused`: the token is wrong or revoked. `expired`: the bearer token ended, signing in again may fix it. */
export type SecretsApiFailure = "refused" | "expired" | "rate-limited" | "cant-connect" | "unreadable";

/** Never carries what Bitwarden answered: a reply may hold anything. */
export class SecretsApiError extends Error {
  readonly failure: SecretsApiFailure;
  constructor(failure: SecretsApiFailure) {
    super(`Bitwarden Secrets Manager: ${failure}`);
    this.name = "SecretsApiError";
    this.failure = failure;
  }
}

export type SecretsFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const TIMEOUT_MS = 20_000;
const BATCH = 100;
/** The bearer token is renewed this long before Bitwarden says it ends. */
const EARLY_MS = 60_000;

function base64(text: unknown): Buffer | null {
  return typeof text === "string" && BASE64.test(text) ? Buffer.from(text, "base64") : null;
}

/** The key a token's 16-byte seed stands for: HKDF-SHA256 with salt "bitwarden-accesstoken" and info "sm-access-token". */
export function accessTokenKey(seed: Buffer): SecretsKey {
  const key = Buffer.from(hkdfSync("sha256", seed, "bitwarden-accesstoken", "sm-access-token", 64));
  return { enc: key.subarray(0, 32), mac: key.subarray(32) };
}

/** Null for anything that is not a version 0 access token. */
export function parseAccessToken(raw: unknown): AccessToken | null {
  if (typeof raw !== "string" || raw.length > 1024) return null;
  const [head, seedText, extra] = raw.trim().split(":");
  if (head === undefined || extra !== undefined) return null;
  const [version, id, clientSecret, ...rest] = head.split(".");
  if (version !== "0" || !id || !UUID.test(id) || !clientSecret || rest.length || /\s/u.test(clientSecret)) return null;
  const seed = base64(seedText);
  return seed?.length === 16 ? { id: id.toLowerCase(), clientSecret, key: accessTokenKey(seed) } : null;
}

/** bitwarden.com and bitwarden.eu answer on their own identity and api hosts; a self-hosted server under its address. */
export function secretsServer(serverUrl: string): SecretsServer {
  const cloud = (BITWARDEN_SERVERS as readonly string[]).includes(serverUrl) ? new URL(serverUrl).host.replace(/^vault\./u, "") : null;
  return cloud ? { identity: `https://identity.${cloud}`, api: `https://api.${cloud}` } : { identity: `${serverUrl}/identity`, api: `${serverUrl}/api` };
}

/** A type 2 EncString, `2.<iv>|<data>|<mac>`, checked before it is decrypted. */
export function decryptEncString(encString: unknown, key: SecretsKey): Buffer {
  const parts = typeof encString === "string" && encString.startsWith("2.") ? encString.slice(2).split("|") : [];
  const [iv, data, mac] = parts.map(base64);
  if (parts.length !== 3 || iv?.length !== 16 || !data?.length || data.length % 16 || mac?.length !== 32) throw new SecretsApiError("unreadable");
  const expected = createHmac("sha256", key.mac).update(iv).update(data).digest();
  if (!timingSafeEqual(expected, mac)) throw new SecretsApiError("unreadable");
  try {
    const decipher = createDecipheriv("aes-256-cbc", key.enc, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new SecretsApiError("unreadable");
  }
}

const decryptText = (encString: unknown, key: SecretsKey) => decryptEncString(encString, key).toString("utf8");

function organizationOf(jwt: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { organization?: unknown };
    return typeof claims.organization === "string" && UUID.test(claims.organization) ? claims.organization : null;
  } catch {
    return null;
  }
}

interface Session { bearer: string; endsAt: number; organizationId: string; key: SecretsKey }

/** One machine account on one server. The bearer token and the organization's key stay in this process's memory. */
export class SecretsManagerClient {
  private readonly server: SecretsServer;
  private readonly token: AccessToken;
  private readonly fetch: SecretsFetch;
  private readonly now: () => number;
  private session: Session | null = null;
  private signingIn: Promise<Session> | null = null;

  constructor(options: { serverUrl: string; token: AccessToken; fetch?: SecretsFetch; now?: () => number }) {
    this.server = secretsServer(options.serverUrl);
    this.token = options.token;
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, { ...init, redirect: "error" }));
    this.now = options.now ?? Date.now;
  }

  /** Every secret the machine account reads, by id and name; no value is read. */
  async list(): Promise<SecretName[]> {
    const { answer, key } = await this.call("GET", (session) => `/organizations/${session.organizationId}/secrets`);
    const secrets = (this.parse(answer) as { secrets?: unknown } | null)?.secrets;
    if (!Array.isArray(secrets)) throw new SecretsApiError("unreadable");
    return (secrets as Array<{ id?: unknown; key?: unknown }>).flatMap((secret) =>
      typeof secret?.id === "string" && UUID.test(secret.id) ? [{ id: secret.id, name: decryptText(secret.key, key) }] : []);
  }

  /** The secrets named, decrypted; one the account no longer reads is left out. */
  async get(ids: readonly string[]): Promise<SecretValue[]> {
    const found: SecretValue[] = [];
    for (let start = 0; start < ids.length; start += BATCH) found.push(...await this.getBatch(ids.slice(start, start + BATCH)));
    return found;
  }

  /** Bitwarden refuses a whole batch with 404 when one secret in it is gone, so a refused batch is read again in halves. */
  private async getBatch(ids: readonly string[]): Promise<SecretValue[]> {
    const { answer, key } = await this.call("POST", () => "/secrets/get-by-ids", { ids });
    if (answer.status === 404) {
      if (ids.length < 2) return [];
      const half = Math.ceil(ids.length / 2);
      return [...await this.getBatch(ids.slice(0, half)), ...await this.getBatch(ids.slice(half))];
    }
    const data = (this.parse(answer) as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new SecretsApiError("unreadable");
    return (data as Array<{ id?: unknown; key?: unknown; value?: unknown; note?: unknown }>).flatMap((secret) => typeof secret?.id === "string"
      ? [{ id: secret.id, name: decryptText(secret.key, key), value: decryptText(secret.value, key), note: secret.note ? decryptText(secret.note, key) : "" }] : []);
  }

  /** Signs in again once when the bearer token was refused. */
  private async call(method: "GET" | "POST", path: (session: Session) => string, body?: unknown): Promise<{ answer: { status: number; text: string }; key: SecretsKey }> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.signIn();
      const answer = await this.send(`${this.server.api}${path(session)}`, method, { authorization: `Bearer ${session.bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
        body ? JSON.stringify(body) : undefined);
      if (answer.status !== 401 || attempt > 0) return { answer, key: session.key };
      if (this.session === session) this.session = null;
    }
  }

  private signIn(): Promise<Session> {
    if (this.session && this.now() < this.session.endsAt) return Promise.resolve(this.session);
    if (this.signingIn) return this.signingIn;
    const running = this.signInNow().finally(() => { if (this.signingIn === running) this.signingIn = null; });
    this.signingIn = running;
    return running;
  }

  private async signInNow(): Promise<Session> {
    const form = new URLSearchParams({ scope: "api.secrets", client_id: this.token.id, client_secret: this.token.clientSecret, grant_type: "client_credentials" });
    const answer = await this.send(`${this.server.identity}/connect/token`, "POST", { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, form.toString());
    if (answer.status === 400 || answer.status === 401) throw new SecretsApiError("refused");
    const reply = this.parse(answer) as { access_token?: unknown; expires_in?: unknown; encrypted_payload?: unknown };
    const organizationId = typeof reply.access_token === "string" ? organizationOf(reply.access_token) : null;
    if (!organizationId || typeof reply.expires_in !== "number") throw new SecretsApiError("unreadable");
    // Bitwarden checks only the client secret; a token whose seed was changed signs in but opens nothing.
    let payload: { encryptionKey?: unknown };
    try { payload = JSON.parse(decryptText(reply.encrypted_payload, this.token.key)) as { encryptionKey?: unknown }; }
    catch { throw new SecretsApiError("refused"); }
    const key = base64(payload.encryptionKey);
    if (key?.length !== 64) throw new SecretsApiError("unreadable");
    this.session = { bearer: reply.access_token as string, endsAt: this.now() + reply.expires_in * 1000 - EARLY_MS, organizationId,
      key: { enc: key.subarray(0, 32), mac: key.subarray(32) } };
    return this.session;
  }

  private async send(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
    try {
      const answer = await this.fetch(url, { method, headers: { accept: "application/json", ...headers }, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: answer.status, text: await answer.text() };
    } catch {
      throw new SecretsApiError("cant-connect");
    }
  }

  private parse(answer: { status: number; text: string }): unknown {
    if (answer.status === 429) throw new SecretsApiError("rate-limited");
    if (answer.status === 401 || answer.status === 403) throw new SecretsApiError("refused");
    if (answer.status >= 500) throw new SecretsApiError("cant-connect");
    if (answer.status < 200 || answer.status >= 300) throw new SecretsApiError("unreadable");
    try { return JSON.parse(answer.text) as unknown; }
    catch { throw new SecretsApiError("unreadable"); }
  }
}
