// "Also use on My Cloud": the desktop app's main process asks this server for one login's secrets, to send them to the
// person's own Cloud. The ask and the answer travel only over Electron's private utility-process port, which no page,
// bot, browser or other local process can reach (a plain Node server has no such port, so this never answers there).
// Nothing here is an HTTP answer, a log line or a chat message, and nothing is kept.
import type { LoginBots } from "../shared/logins.ts";
import { loginFingerprints, VERIFY_NONCE } from "./cloud-send-verify.ts";
import type { LoginStore } from "./login-store.ts";
import { ONE_PASSWORD_MALFORMED, ONE_PASSWORD_REFUSED } from "./onepassword.ts";
import type { TotpKey } from "./totp.ts";

export const LOGIN_HANDOFF_REQUEST = "openmausbot:login-handoff";
export const LOGIN_HANDOFF_RESULT = "openmausbot:login-handoff-result";

export type LoginHandoffWhat = { kind: "1password" } | { kind: "login"; id: string } | { kind: "verify-secrets"; nonce: string };
/** For a move to the person's own Cloud: one connection's secrets, a code for that Cloud to act as this computer's
 * connected-apps account, or letting go of a sign-in that moved there (cloud-connections.ts). */
export type ConnectionHandoffWhat =
  | { kind: "connection"; id: string }
  | { kind: "composio-share"; for: string }
  | { kind: "connection-release"; id: string; digest: string }
  | { kind: "connection-fingerprints"; nonce: string };
export type ConnectionHandoffAnswer =
  | { ok: true; connection: object; digest?: string }
  | { ok: true; share: { code: string } }
  | { ok: true; release: { released: true } | { changed: true } }
  | { ok: true; secrets: Record<string, string> }
  | { ok: false; error: string };

/** A saved login as the Cloud's own POST /api/logins takes it: one sign-in address, the 2FA key as an otpauth:// address. */
export interface HandedLogin {
  site: string;
  exactHost: boolean;
  username: string;
  password: string;
  totp: string | null;
  bots: LoginBots;
}

export type LoginHandoffAnswer =
  | { ok: true; onePassword: { token: string; grants: Record<string, LoginBots> } }
  | { ok: true; login: HandedLogin }
  | { ok: true; secrets: Record<string, string> }
  | { ok: false; error: string };
export type LoginHandoffResult = { type: typeof LOGIN_HANDOFF_RESULT; requestId: string } & (LoginHandoffAnswer | ConnectionHandoffAnswer);

const REQUEST_ID = /^[\w-]{8,64}$/u;
const LOGIN_ID = /^[\w-]{1,128}$/u;
const CONNECTION_ID = /^(?:mcp:[a-z][a-z0-9_-]{0,31}|key:\w{1,40}|composio|highlevel)$/u;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function totpAddress(key: TotpKey): string {
  const query = new URLSearchParams({ secret: key.secret, algorithm: key.algorithm, digits: String(key.digits), period: String(key.period) });
  return `otpauth://totp/OpenMausBot?${query}`;
}

/** What main may ask: a connection's fingerprints are asked only on its behalf, by a check of the credentials. */
type Ask = LoginHandoffWhat | Exclude<ConnectionHandoffWhat, { kind: "connection-fingerprints" }>;

function parse(raw: unknown): { requestId: string; what: Ask } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = raw as Record<string, unknown>;
  if (message.type !== LOGIN_HANDOFF_REQUEST || typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId)) return null;
  const what = message.what as Record<string, unknown> | null;
  if (what?.kind === "1password") return { requestId: message.requestId, what: { kind: "1password" } };
  if (what?.kind === "login" && typeof what.id === "string" && LOGIN_ID.test(what.id)) return { requestId: message.requestId, what: { kind: "login", id: what.id } };
  if (what?.kind === "connection" && typeof what.id === "string" && CONNECTION_ID.test(what.id)) return { requestId: message.requestId, what: { kind: "connection", id: what.id } };
  if (what?.kind === "composio-share" && typeof what.for === "string" && INSTALLATION_ID.test(what.for)) return { requestId: message.requestId, what: { kind: "composio-share", for: what.for } };
  if (what?.kind === "connection-release" && typeof what.id === "string" && CONNECTION_ID.test(what.id) && typeof what.digest === "string" && DIGEST.test(what.digest)) {
    return { requestId: message.requestId, what: { kind: "connection-release", id: what.id, digest: what.digest } };
  }
  if (what?.kind === "verify-secrets" && typeof what.nonce === "string" && VERIFY_NONCE.test(what.nonce)) return { requestId: message.requestId, what: { kind: "verify-secrets", nonce: what.nonce } };
  return null;
}

type HandoffStore = Pick<LoginStore, "changes" | "get" | "onePasswordToken" | "onePasswordGrants">;
/** This computer's own 1Password problem, from its last read of the vaults (OnePasswordLogins.status().error). */
type OnePasswordProblem = () => string | undefined;

export const ONE_PASSWORD_DEAD_HERE = "1Password did not accept this computer's token, so it was not sent to My Cloud. Connect 1Password again in Settings → Logins with a new service account token, and it goes to My Cloud by itself.";

export function answerLoginHandoff(store: HandoffStore, what: Exclude<LoginHandoffWhat, { kind: "verify-secrets" }>, onePasswordProblem: OnePasswordProblem = () => undefined): LoginHandoffAnswer {
  if (what.kind === "1password") {
    const token = store.onePasswordToken();
    if (!token) return { ok: false, error: "1Password is not connected on this computer." };
    // 1Password itself refused this token here: My Cloud would only refuse it too, in words meant for its own page.
    const problem = onePasswordProblem();
    if (problem === ONE_PASSWORD_REFUSED || problem === ONE_PASSWORD_MALFORMED) return { ok: false, error: ONE_PASSWORD_DEAD_HERE };
    return { ok: true, onePassword: { token, grants: store.onePasswordGrants() } };
  }
  const login = store.get(what.id);
  if (!login) return { ok: false, error: "This login is no longer saved on this computer." };
  return { ok: true, login: { site: login.hosts[0] ?? login.site, exactHost: login.exactHost, username: login.username, password: login.password,
    totp: login.totp ? totpAddress(login.totp) : null, bots: login.bots } };
}

/** True when the message was a handoff ask, answered or refused; anything else is left for the next handler. A
 * connection's ask is answered by `connections`, once its answer is ready. */
export function receiveLoginHandoff(raw: unknown, store: HandoffStore, post: (message: LoginHandoffResult) => boolean, onePasswordProblem?: OnePasswordProblem,
  connections?: (what: ConnectionHandoffWhat) => Promise<ConnectionHandoffAnswer>): boolean {
  if ((raw as { type?: unknown } | null)?.type !== LOGIN_HANDOFF_REQUEST) return false;
  const ask = parse(raw);
  if (!ask) return true;
  const { requestId, what } = ask;
  if (what.kind === "connection" || what.kind === "composio-share" || what.kind === "connection-release") {
    const refused: ConnectionHandoffAnswer = { ok: false, error: "This connection could not be read on this computer." };
    const answer = connections ? connections(what).catch((): ConnectionHandoffAnswer => refused) : Promise.resolve(refused);
    void answer.then((answered) => post({ type: LOGIN_HANDOFF_RESULT, requestId, ...answered }));
    return true;
  }
  if (what.kind === "verify-secrets") {
    const logins = loginFingerprints(what.nonce, store);
    const theirs = connections ? connections({ kind: "connection-fingerprints", nonce: what.nonce }).catch(() => null) : Promise.resolve(null);
    void theirs.then((answered) => post(answered?.ok && "secrets" in answered ? { type: LOGIN_HANDOFF_RESULT, requestId, ok: true, secrets: { ...logins, ...answered.secrets } }
      : { type: LOGIN_HANDOFF_RESULT, requestId, ok: false, error: "This computer's apps and keys could not be checked." }));
    return true;
  }
  post({ type: LOGIN_HANDOFF_RESULT, requestId, ...answerLoginHandoff(store, what, onePasswordProblem) });
  return true;
}
