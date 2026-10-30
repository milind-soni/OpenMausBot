// Trades the one-time code for this server's own agent token, once, over HTTPS.
import { errorText } from "./log.ts";
import { ENROLL_PATH, checkEnrollCode, checkEnrollResponse, isLoopbackHost, type ConnectorIdentity, type HostFacts } from "./protocol.ts";
import type { AgentRecord } from "./state.ts";

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
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<AgentRecord> {
  const code = checkEnrollCode(options.code.trim());
  if (!code.ok) throw new Error(code.message);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.admin}${ENROLL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.value, host: options.host, connector: options.connector }),
      signal: AbortSignal.timeout(30_000),
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
  return { version: 1, admin: options.admin, ...checked.value, enrolledAt: (options.now ?? Date.now)() };
}
