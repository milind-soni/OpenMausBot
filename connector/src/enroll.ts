// Trades the one-time code for this server's place in the team: a key made here, whose public half the Admin keeps, and
// the Admin's own keys, which the connector pins. Once, over HTTPS.
import { errorText } from "./log.ts";
import { ENROLL_PATH, checkEnrollCode, checkEnrollResponse, isLoopbackHost, type ConnectorIdentity, type EnrollRequest, type HostFacts, type ServerMode } from "./protocol.ts";
import { generateKeyPair } from "./signed.ts";
import type { AgentRecord } from "./state.ts";

/** A slow link or a busy Admin is not a refusal; the person runs the install command again if this passes. */
const ENROLL_TIMEOUT_MS = 2 * 60_000;

/** The Admin's origin: https, or http on this machine's loopback for a test Admin. */
export function adminOrigin(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new Error("The install command did not say which MausBot to connect to. Copy the install command from MausBot again.");
  }
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
    throw new Error(`${url.origin} is not a MausBot address this connector may use.`);
  }
  return url.origin;
}

export async function enroll(options: {
  admin: string;
  code: string;
  host: HostFacts;
  connector: ConnectorIdentity;
  /** Absent: `operated`. */
  mode?: ServerMode;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<AgentRecord> {
  const code = checkEnrollCode(options.code.trim());
  if (!code.ok) throw new Error(code.message);
  const key = generateKeyPair();
  const customerRun = options.mode === "customer-run";
  const request: EnrollRequest = { code: code.value, publicKey: key.publicKey, host: options.host, connector: options.connector, ...(customerRun ? { mode: "customer-run" } : {}) };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.admin}${ENROLL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? ENROLL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`This server can't reach MausBot at ${options.admin} (${errorText(error)}). Check that it can make outbound HTTPS connections, then run the install command again.`);
  }
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
    throw new Error("This code isn't valid anymore: a code works once, for one hour. Make a new one in MausBot and run the install command again.");
  }
  if (!response.ok) throw new Error(`MausBot answered ${response.status} to the connection request. Try the install command again in a minute.`);
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  const checked = checkEnrollResponse(body);
  if (!checked.ok) throw new Error(`MausBot's answer could not be used (${checked.message}). Try the install command again.`);
  const { boxId, teamId, adminKeys } = checked.value;
  return { version: 2, admin: options.admin, boxId, teamId, publicKey: key.publicKey, privateKey: key.privateKey, adminKeys, enrolledAt: (options.now ?? Date.now)(), ...(customerRun ? { mode: "customer-run" } : {}) };
}
