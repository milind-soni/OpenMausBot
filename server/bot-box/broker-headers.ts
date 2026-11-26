// Saved values the box's gates put in request headers, and what a gate does when one cannot be sent. Node refuses a
// header holding a control character (a pasted key's newline) or a character beyond Latin-1 (a smart quote) by throwing
// where the request is built, inside the gate's request handler: unguarded, that one saved key took the whole server
// down at every start. Here a key's surrounding whitespace is dropped so it simply works, what still cannot be sent
// fails only the request that carries it with words naming the credential (never its value), and anything else a
// gate's handler throws fails that request, not the process.
import { validateHeaderName, validateHeaderValue, type IncomingMessage, type ServerResponse } from "node:http";

/** A credential header's value as a gate sends it: the whitespace a paste leaves around a key (a trailing newline) dropped. */
export function trimmedHeaderValues(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, typeof value === "string" ? value.trim() : value]));
}

/** The name of the first header Node would refuse to send, or null when every one can go. Never its value. */
export function unsendableHeader(headers: Record<string, string | string[]>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    try {
      validateHeaderName(name);
      for (const one of Array.isArray(value) ? value : [value]) validateHeaderValue(name, one);
    } catch {
      return name;
    }
  }
  return null;
}

export const UNUSABLE_CREDENTIAL = "unusable_credential";

/** What a gate answers for a saved credential it cannot send: which one (the grant and the header), never the value. */
export function unusableCredentialBody(credential: string, header: string): string {
  return JSON.stringify({
    error: UNUSABLE_CREDENTIAL,
    credential,
    header,
    message: `The saved key for ${credential} cannot be used: it contains characters that are not allowed. Save it again.`,
  });
}

/** A gate's request handler whose throw (or rejection) fails that request with a 502, never the process. */
export function guardedHandler(
  name: string,
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  log: (line: string) => void = (line) => console.warn(line),
): (req: IncomingMessage, res: ServerResponse) => void {
  const fail = (req: IncomingMessage, res: ServerResponse, error: unknown) => {
    // The code only (ERR_INVALID_CHAR, ...): a message may quote the header value it refused.
    const code = (error as { code?: unknown } | null)?.code;
    log(`${name}: a request failed${typeof code === "string" ? ` [${code}]` : ""}; the gate keeps serving`);
    try {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: "gate_error" }));
      else res.destroy();
    } catch { res.destroy(); }
    req.resume();
  };
  return (req, res) => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) result.catch((error: unknown) => fail(req, res, error));
    } catch (error) {
      fail(req, res, error);
    }
  };
}
