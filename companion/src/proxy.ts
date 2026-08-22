// The forwarding half of the sidecar.
//
// A device's request arrives here, is checked against the allowlist, and is
// replayed to the harness on 127.0.0.1 as a request from this machine. The
// response comes back scrubbed.
//
// The reason this works with an unmodified harness is worth stating plainly,
// because it is the whole basis of the design: the harness rejects any
// request whose Host is not loopback — a DNS-rebinding defence — and a
// request this process makes to 127.0.0.1 satisfies that by construction. So
// the sidecar does NOT forward the device's Host or Origin. It speaks to the
// harness as itself, from the machine the harness is already willing to
// serve. Nothing upstream has to change, or even know this exists.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import { bearerToken } from "./devices.ts";
import { denyReason, isCloudDesktopJoin } from "./routes.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";

/** What the forwarding handler needs from the process around it. */
export interface ProxyOptions {
  /** Where the harness is listening on loopback. */
  harnessPort: number;
  /** Does this bearer token belong to a paired device? */
  authenticate: (token: string | undefined) => { cloudDesktopAccess: boolean } | null;
  /** Redeem a pairing code. Handled here and never forwarded: the harness
   * has no such route and no idea devices exist — pairing is the sidecar's
   * own concern, and the one thing a device does before it has a token. */
  redeem: (
    code: string,
    deviceName: unknown,
  ) => { token: string; device: unknown } | { error: string };
  /** What the phone should call this computer in its connection list. */
  serverName: () => string;
  /** Every host the phone could dial later, best first — sent with the
   * pairing response so the app can fall back when the address it paired on
   * stops resolving. Optional and advisory: a phone that never receives it
   * simply keeps dialing the one host it paired with. */
  hosts?: () => string[];
  /** How long the harness may take to produce response *headers*. Optional,
   * and only ever set by tests — the default is the one that ships. */
  headersTimeoutMs?: number;
}

/** The harness has this long to send a status line and headers.
 *
 * Headers only. Once they arrive the clock is off and the body may take as
 * long as it likes, which is the whole point: an SSE stream is a response
 * that deliberately never ends, and a timeout that could not tell the
 * difference would cut every live stream at thirty seconds. */
const HEADERS_TIMEOUT_MS = 30_000;

/** A JSON response has to be buffered whole before it can be scrubbed, so the
 * buffer is the size of the response and nothing upstream promises that is
 * small. Far above any real payload — it exists to have a ceiling at all. */
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/** Read a JSON body, bounded. An unbounded read on an unauthenticated route
 * is a way to be memory-exhausted by anyone who can reach the port. */
const readJson = (req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });

/** Answer with JSON the sidecar wrote itself — a refusal, or a pairing
 * result. Anything from the harness goes out through the proxy path instead.
 *
 * Unless the response has already begun. Once a byte is on the wire the
 * status line is spent and `writeHead` throws ERR_HTTP_HEADERS_SENT, which
 * on the failure paths — an upstream dying long after SSE headers were
 * flushed — would be a second, fatal error raised inside an error handler
 * with nothing to catch it. Dropping the socket is the only honest ending
 * left there: the device sees a truncated response and reconnects, which is
 * what it already does for any dropped connection. */
const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

/** Headers worth carrying to the harness. An allowlist rather than a
 * blocklist: `host` and `origin` must not travel (see above), `authorization`
 * is the sidecar's credential and means nothing to the harness, and hop-by-hop
 * headers are by definition not ours to relay. */
const forwardHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = { accept: String(req.headers.accept ?? "*/*") };
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  // Last-Event-ID is how a reconnecting client asks for the gap. Dropping it
  // would turn every resume into a full re-hydration, silently.
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) out["last-event-id"] = String(lastEventId);
  return out;
};

/** The device-facing handler: refuse a browser, check the allowlist, check
 * the token, then replay the request to the harness over loopback and scrub
 * what comes back. Pairing is the one route that stops here. */
export function createProxyHandler(options: ProxyOptions) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    // A native app sends no Origin. Anything that does is a browser that has
    // found this port, and a browser has no business on it — refused before
    // the token is even looked at, and regardless of what the origin says.
    if (req.headers.origin) {
      return sendJson(res, 403, { error: "forbidden: cross-origin request" });
    }

    const token = bearerToken(req.headers.authorization);
    const device = options.authenticate(token);
    const denial = denyReason({
      path,
      method,
      // `bearerToken` is the registry's own parser, imported rather than
      // reimplemented: this file used to have a second one, and two parsers
      // that disagree about what a credential looks like means the header a
      // phone sends authenticates on one code path and not the other.
      authenticated: Boolean(device),
    });
    if (denial) return sendJson(res, denial.status, { error: denial.error });

    // Pairing a phone grants the ordinary companion surface, not a browser
    // session with every credential that may exist inside the cloud desktop.
    // The computer owner enables this capability per device, off by default.
    if (isCloudDesktopJoin(method, path) && !device?.cloudDesktopAccess) {
      return sendJson(res, 403, {
        error: "cloud desktop access is off for this phone — enable it in OpenMausBot → Settings → Companion",
      });
    }

    // Pairing terminates here. Forwarding it would hand the harness a route
    // it does not have, and the 404 would read to a phone as "wrong address".
    if (method === "POST" && path === "/api/pair") {
      readJson(req).then(
        (body) => {
          // New clients redeem the high-entropy credential carried by the QR.
          // `code` remains accepted for manual entry and older mobile builds.
          const result = options.redeem(String(body.credential ?? body.code ?? ""), body.deviceName);
          if ("error" in result) return sendJson(res, 401, { error: result.error });
          // `hosts` rides along whichever way the phone paired — QR, typed
          // address, or discovery — so every paired device learns the full
          // fallback list, not just the ones that scanned a QR. Absent, not
          // empty, when there is nothing to offer: absent is what a sidecar
          // predating the field sends, and one decode path beats two.
          const hosts = options.hosts?.() ?? [];
          const response: typeof result & { serverName: string; hosts?: string[] } = {
            ...result,
            serverName: options.serverName(),
          };
          if (hosts.length) response.hosts = hosts;
          return sendJson(res, 201, response);
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.harnessPort,
        path: req.url,
        method,
        headers: forwardHeaders(req),
      },
      (harness) => {
        clearTimeout(headersDeadline);
        const contentType = harness.headers["content-type"];
        const isStream = String(contentType ?? "").includes("text/event-stream");

        if (isStream) {
          // Headers first and flushed, or nothing downstream believes the
          // connection is live. content-length is meaningless here and
          // content-encoding would be a lie once we rewrite the bytes.
          res.writeHead(harness.statusCode ?? 200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            // Nagle would hold a small frame back waiting for company. On a
            // stream whose frames are small and whose whole value is being
            // timely, that is exactly wrong.
            "x-accel-buffering": "no",
          });
          res.flushHeaders?.();
          res.socket?.setNoDelay(true);

          const scrubStream = createSseScrubber();
          harness.setEncoding("utf8");
          harness.on("data", (chunk: string) => {
            let rewritten: string;
            try {
              rewritten = scrubStream(chunk);
            } catch {
              // The buffer ceiling. Half an event cannot be forwarded safely,
              // so the stream ends here rather than growing without bound.
              harness.destroy();
              res.end();
              return;
            }
            if (!rewritten) return;
            // A phone on a slow link reads slower than the harness writes,
            // and the difference has to go somewhere. Ignoring what write()
            // returns puts it in this process's memory, unbounded, for as
            // long as the phone stays connected and behind. Pausing pushes it
            // back to the harness, which is where the backlog belongs.
            if (!res.write(rewritten)) harness.pause();
          });
          res.on("drain", () => harness.resume());
          harness.on("end", () => res.end());
          harness.on("error", () => res.destroy());
          // A device that hangs up must take the upstream connection with
          // it, or the harness accumulates readers nobody is listening to.
          res.on("close", () => harness.destroy());
          return;
        }

        const encoding = String(harness.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        if (!isJson(String(contentType ?? "")) || (encoding && encoding !== "identity")) {
          // images and anything else: byte-for-byte, no parsing.
          //
          // Encoded bodies come through here too. Scrubbing one would mean
          // decompressing it, and the alternative the buffering branch would
          // otherwise reach — decode as UTF-8, re-serialise, drop the
          // content-encoding header — corrupts it silently. `forwardHeaders`
          // never sends accept-encoding, so this is a guard rather than a
          // path: if it ever fires, the body passes through unscrubbed and
          // intact rather than scrubbed and broken.
          res.writeHead(harness.statusCode ?? 200, harness.headers);
          // `pipe` does not carry a failure from source to destination. An
          // upstream that dies part-way through an image would otherwise
          // leave the phone holding an open connection and a content-length
          // that will never be satisfied — it waits for the rest forever,
          // which reads as a frozen app rather than as a failed request.
          harness.on("error", () => res.destroy());
          harness.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        harness.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_BODY_BYTES) {
            harness.destroy();
            if (res.headersSent) res.destroy();
            else sendJson(res, 502, { error: "the response from OpenMausBot was too large" });
            return;
          }
          chunks.push(chunk);
        });
        harness.on("error", () => res.destroy());
        harness.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          // Two failures live here and they are not the same failure.
          //
          // A body that does not parse was never JSON — the content-type
          // lied, or the harness sent an empty 204. There is nothing to
          // redact in bytes that do not read as an object, so forwarding
          // them verbatim is correct.
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            forward(body, harness.headers, harness.statusCode ?? 200);
            return;
          }

          // A body that parses but will not scrub is the opposite case. We
          // know it is structured, and `scrub` is the only thing keeping the
          // harness's internal fields — the resume cursors — off the wire to
          // a device. Falling back to the raw body there, which is what one
          // try around parse-and-scrub used to do, sends exactly what the
          // scrubber exists to withhold. Not hypothetical: `scrub` recurses,
          // so a body nested a few thousand deep throws RangeError where
          // JSON.parse handles it fine.
          let text: string;
          try {
            text = JSON.stringify(scrub(parsed));
          } catch {
            sendJson(res, 502, { error: "the response could not be prepared for this device" });
            return;
          }
          forward(text, harness.headers, harness.statusCode ?? 200);
        });

        /** Re-frame and send. The body was re-serialised, so nothing the
         * harness said about its framing survives. `transfer-encoding`
         * matters most: leaving it alongside the content-length set here is
         * a protocol violation, and Node's own parser rejects the response
         * outright rather than tolerating it. */
        function forward(text: string, upstreamHeaders: IncomingMessage["headers"], status: number): void {
          const headers = { ...upstreamHeaders };
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          res.writeHead(status, {
            ...headers,
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
        }
      },
    );

    // A phone can go away at any point: before the harness has answered,
    // while its own request body is still going up, or partway through a
    // large response. Every one of those leaves the harness producing for
    // nobody unless the upstream goes with it. Guarded on `writableEnded` so
    // an ordinary finished response does not tear down a keep-alive socket
    // on its way out.
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());

    // `http.request` has no deadline of its own for the headers phase: a
    // harness that accepts the connection and then says nothing holds the
    // device's request open until one side gives up, which neither does.
    let timedOut = false;
    const headersDeadline = setTimeout(() => {
      timedOut = true;
      upstream.destroy(new Error("the harness sent no response headers"));
    }, options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS);
    headersDeadline.unref?.();

    upstream.on("error", () => {
      clearTimeout(headersDeadline);
      // Headers already went out — a stream, or a piped body — or the
      // response is finished and this is a socket dying afterwards. There is
      // no status code left to send in either case, and writeHead here throws
      // ERR_HTTP_HEADERS_SENT out of an event handler with nothing to catch
      // it, taking the whole sidecar down over one dead connection. Dropping
      // the socket is the only honest signal, and one a client recovers from.
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      sendJson(
        res,
        timedOut ? 504 : 502,
        timedOut
          ? { error: "OpenMausBot did not respond" }
          : { error: "OpenMausBot is not running on this computer" },
      );
    });
    req.pipe(upstream);
  };
}
