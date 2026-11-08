// Before connecting, the Connect sheet asks the address who it is: the server's public descriptor names it, and a
// failure is sorted into one thing the person can fix.
import { EXAMPLE_ADDRESS, isLoopbackHost, parseServerInput, serverTransport } from "./server-address.mjs";

const DESCRIPTOR = "/.well-known/openmausbot/environment";
/** A MausBot desktop app's Remote access (companion/src/routes.ts) refuses the descriptor with this until a phone pairs. */
const DESKTOP_APP_REFUSAL = /^pair this device from Remote access settings/;

/** The sentence for each problem, in the window's catalog and main's alike ({host}, {example} filled in). */
export const CONNECT_PROBLEM_KEYS = Object.freeze({
  empty: "native.connect.empty",
  codeOnly: "native.connect.codeOnly",
  emailCode: "native.connect.emailCode",
  oldCode: "native.connect.oldCode",
  scriptKey: "native.connect.scriptKey",
  notACode: "native.connect.notACode",
  publicHttp: "native.connect.publicHttp",
  phoneLink: "native.connect.phoneLink",
  notAnAddress: "native.connect.notAnAddress",
  unreachable: "native.connect.unreachable",
  dns: "native.connect.dns",
  certificate: "native.connect.certificate",
  notMausBot: "native.connect.notMausBot",
  desktopApp: "native.connect.desktopApp",
  loopback: "native.connect.loopback",
  localNetwork: "native.connect.localNetwork",
});

/** Chromium's net errors (Electron 43 `session.fetch`) and Node's (undici) for the same causes. */
function failureKind(error) {
  const text = `${error?.message ?? ""} ${error?.cause?.code ?? ""} ${error?.cause?.message ?? ""} ${error?.name ?? ""}`;
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|EAI_NONAME/i.test(text)) return "dns";
  if (/ERR_CERT|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|certificate/i.test(text)) return "certificate";
  if (/TimeoutError|TIMED_OUT|ETIMEDOUT|aborted/i.test(text)) return "timeout";
  if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) return "refused";
  return "unreachable";
}

const REFUSAL_MAX_BYTES = 4_096;

/** The body as text, or null once it passes REFUSAL_MAX_BYTES, whatever Content-Length said. */
async function readSmallBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REFUSAL_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A desktop app's companion refusal is a small JSON body; anything larger or not shaped like it isn't one. */
async function isDesktopAppRefusal(response) {
  if (Number(response.headers?.get?.("content-length")) > REFUSAL_MAX_BYTES) return false;
  const text = await readSmallBody(response).catch(() => null);
  if (text === null) return false;
  let error;
  try { error = JSON.parse(text)?.error; } catch { return false; }
  return typeof error === "string" && DESKTOP_APP_REFUSAL.test(error);
}

async function describe(origin, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${origin}${DESCRIPTOR}`, { redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, kind: failureKind(error) };
  }
  if (response.status === 401) return { ok: false, kind: await isDesktopAppRefusal(response) ? "desktopApp" : "notMausBot" };
  if (!response.ok) return { ok: false, kind: "notMausBot" };
  const body = await response.json().catch(() => null);
  if (typeof body?.environmentId !== "string" || !body.environmentId) return { ok: false, kind: "notMausBot" };
  return { ok: true, environmentId: body.environmentId, label: typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : new URL(origin).host,
    version: typeof body.version === "string" ? body.version.slice(0, 32) : null };
}

/**
 * Reads the sheet's fields and finds the server: `{ outcome: "found", origin, label, version, transport, code, credential }`,
 * or `{ outcome: "problem", problem, host?, code? }` with one of parseServerInput's problems or: unreachable, dns,
 * certificate, notMausBot, desktopApp (another computer's MausBot desktop app, which can't be a server), loopback (an address on this computer that is this app's own workspace, or nothing at all).
 * `ownEnvironmentId()`: this app's own local workspace, so a "this computer" link copied off a server is caught.
 */
export async function probeServer({ address, code = "", fetch: fetchImpl, ownEnvironmentId = async () => null, timeoutMs = 6_000, platform = process.platform }) {
  const parsed = parseServerInput(address, code);
  if (!parsed.ok) {
    const { ok: _ok, ...problem } = parsed;
    return { outcome: "problem", ...problem };
  }
  let failure = null;
  for (const origin of parsed.candidates) {
    const host = new URL(origin).host;
    const loopback = isLoopbackHost(new URL(origin).hostname);
    const found = await describe(origin, fetchImpl, timeoutMs);
    if (!found.ok) {
      // macOS 15 blocks an app from the local network until the person allows it, and the request then just fails.
      const blockedOnMac = platform === "darwin" && serverTransport(origin) === "private-http" && (found.kind === "unreachable" || found.kind === "timeout");
      // Once a candidate turned out to be another computer's desktop app, that's the problem to report.
      if (failure?.problem === "desktopApp") continue;
      failure = loopback ? { problem: "loopback", host } : blockedOnMac ? { problem: "localNetwork", host }
        : { problem: found.kind === "refused" || found.kind === "timeout" ? "unreachable" : found.kind, host, ...(found.kind === "refused" || found.kind === "timeout" ? { reason: found.kind } : {}) };
      continue;
    }
    if (loopback && found.environmentId === await ownEnvironmentId().catch(() => null)) return { outcome: "problem", problem: "loopback", host };
    return { outcome: "found", origin, label: found.label, version: found.version, transport: serverTransport(origin), code: parsed.code, credential: parsed.credential };
  }
  return { outcome: "problem", ...failure };
}

/**
 * Connecting from the desktop: `probe` for the sheet's line under the field; `connect` for its button, which names the
 * server already, so it opens exactly what it finds or resolves with the problem; `connectAsking` for a link from the
 * clipboard or Settings, which names the server in main's own dialog (`ask(found)`) first and throws a problem's sentence.
 * `open(found, name)` saves the server and opens its /pair page.
 */
export function createServerConnect({ fetch: fetchImpl, ownEnvironmentId, ask, open, t }) {
  const probe = (address, code = "") => probeServer({ address, code, fetch: fetchImpl, ownEnvironmentId });
  return {
    probe,
    async connect(address, code = "") {
      const found = await probe(address, code);
      if (found.outcome !== "found") return found;
      open(found);
      return { outcome: "connected", label: found.label };
    },
    async connectAsking(input, name) {
      const found = await probe(input);
      if (found.outcome !== "found") throw new Error(t(CONNECT_PROBLEM_KEYS[found.problem], { host: found.host ?? "", example: EXAMPLE_ADDRESS }));
      if (!(await ask(found))) return false;
      open(found, name);
      return true;
    },
  };
}
