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
// serve. Packaged harnesses also require a private per-launch relay capability,
// attached only after authenticating the phone and authorizing its route.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { bearerToken } from "./devices.ts";
import {
  COMPANION_ENDPOINT_KINDS,
  MAX_COMPANION_ENDPOINTS,
  type CompanionEndpoint,
} from "./endpoints.ts";
import { denyReason, isCloudDesktopAccess, isMessageFileDownload } from "./routes.ts";
import { CompanionViewerRelay } from "./viewer-relay.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";

/** What the forwarding handler needs from the process around it. */
export interface ProxyOptions {
  /** Where the harness is listening on loopback. */
  harnessPort: number;
  /** Private Electron capability; null means bootstrap is not ready yet.
   * Undefined keeps standalone sidecars compatible with a plain Node harness. */
  mutationToken?: () => string | null;
  /** Does this bearer token belong to a paired device? */
  authenticate: (token: string | undefined) => { id?: string; cloudDesktopAccess: boolean } | null;
  /** Redeem a pairing code. Handled here and never forwarded: the harness
   * has no such route and no idea devices exist — pairing is the sidecar's
   * own concern, and the one thing a device does before it has a token. */
  redeem: (
    code: string,
    deviceName: unknown,
    pairRequestId?: unknown,
  ) => { token: string; device: unknown } | { error: string };
  /** What the phone should call this computer in its connection list. */
  serverName: () => string;
  /** Every host the phone could dial later, best first — sent with the
   * pairing response so the app can fall back when the address it paired on
   * stops resolving. Optional and advisory: a phone that never receives it
   * simply keeps dialing the one host it paired with. */
  hosts?: () => string[];
  /** Complete connection URLs for current mobile clients. `hosts` remains
   * alongside this field for builds that predate typed endpoints. */
  endpoints?: () => CompanionEndpoint[];
  /** Register one authenticated, live event stream. The tracker can terminate
   * it synchronously when that device is revoked; the returned disposer is
   * called exactly once when either side closes it. */
  connected?: (deviceId: string, disconnect: () => void) => () => void;
  /** How long the harness may take to produce response *headers*. Optional,
   * and only ever set by tests — the default is the one that ships. */
  headersTimeoutMs?: number;
}

export interface CompanionEndpointSnapshot {
  serverName: string;
  endpoints: CompanionEndpoint[];
}

/** The harness has this long to send a status line and headers.
 *
 * Headers only. Once they arrive the clock is off and the body may take as
 * long as it likes, which is the whole point: an SSE stream is a response
 * that deliberately never ends, and a timeout that could not tell the
 * difference would cut every live stream at thirty seconds. */
const HEADERS_TIMEOUT_MS = 30_000;
// Secure credential saves include bounded provider validation before the
// encrypted desktop store commits. Keep this beyond the server's 90-second
// private-save deadline but comfortably inside the hosted proxy's deadline,
// leaving time for the final card update and response to travel back.
const PHONE_SECRET_HEADERS_TIMEOUT_MS = 105_000;
const PHONE_SECRET_PROVIDE_PATH = /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/provide(?:\?|$)/;

export function proxyHeadersTimeoutMs(url: string, override?: number): number {
  return override
    ?? (PHONE_SECRET_PROVIDE_PATH.test(url) ? PHONE_SECRET_HEADERS_TIMEOUT_MS : HEADERS_TIMEOUT_MS);
}

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
const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  pragma: "no-cache",
  vary: "Authorization",
} as const;

/** Device responses can cross a public CDN when the managed HTTPS endpoint
 * is enabled. Never let chat JSON, images, audio, pairing responses, or even
 * authorization failures become shared cache entries. These values override
 * anything the loopback harness supplied. */
const privateHeaders = (headers: IncomingMessage["headers"] = {}): IncomingMessage["headers"] => ({
  ...headers,
  ...PRIVATE_RESPONSE_HEADERS,
});

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...PRIVATE_RESPONSE_HEADERS,
  });
  res.end(text);
};

/** Reduce live endpoint metadata to the same tiny public shape returned at
 * pairing time. The hook is internal, but this still validates and caps it at
 * the network boundary so a future producer cannot accidentally publish an
 * extra field, path-bearing URL, or unbounded list. */
const endpointSnapshot = (options: ProxyOptions): CompanionEndpointSnapshot => {
  const endpoints: CompanionEndpoint[] = [];
  const seen = new Set<string>();
  for (const candidate of options.endpoints?.() ?? []) {
    if (endpoints.length >= MAX_COMPANION_ENDPOINTS) break;
    if (
      !candidate ||
      !COMPANION_ENDPOINT_KINDS.includes(candidate.kind) ||
      typeof candidate.url !== "string" ||
      !Number.isSafeInteger(candidate.priority) ||
      candidate.priority < 0 ||
      candidate.priority > 10_000 ||
      Buffer.byteLength(candidate.url) > 2_048
    ) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      continue;
    }
    const url = parsed.origin;
    if (seen.has(url)) continue;
    seen.add(url);
    endpoints.push({
      kind: candidate.kind,
      priority: candidate.priority,
      url,
    });
  }
  return {
    serverName: [...options.serverName()].slice(0, 200).join(""),
    endpoints,
  };
};

/** Headers worth carrying to the harness. An allowlist rather than a
 * blocklist: `host` and `origin` must not travel (see above), `authorization`
 * is the sidecar's credential and means nothing to the harness, and hop-by-hop
 * headers are by definition not ours to relay. */
const forwardHeaders = (req: IncomingMessage, authenticatedDeviceId?: string, mutationToken?: string): Record<string, string> => {
  const out: Record<string, string> = {
    accept: String(req.headers.accept ?? "*/*"),
    // Lets a response whose URL is intentionally loopback-only (the VPS SSH
    // viewer) fail before opening a tunnel a phone cannot reach. This header
    // carries no authority; it only narrows behavior at the harness.
    "x-openmausbot-companion": "1",
  };
  // Never forward a caller-supplied device header. This value comes only
  // from the registry entry which authenticated the bearer above, allowing
  // the harness to bind an encrypted credential to the same paired phone.
  if (authenticatedDeviceId && /^[\w-]{1,128}$/.test(authenticatedDeviceId)) {
    out["x-openmausbot-companion-device"] = authenticatedDeviceId;
    if (mutationToken) out["x-openmausbot-companion-auth"] = mutationToken;
  }
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  // Preserve a trustworthy byte count for bounded raw uploads. Without it,
  // the harness must grow its disk-quota reservation as each streamed chunk
  // arrives. Node has already parsed this as one request header; keep an
  // additional canonical-decimal check before replaying it upstream.
  const contentLength = req.headers["content-length"];
  if (
    typeof contentLength === "string"
    && /^(?:0|[1-9]\d*)$/.test(contentLength)
    && Number.isSafeInteger(Number(contentLength))
  ) {
    out["content-length"] = contentLength;
  }
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
  const viewers = new CompanionViewerRelay();
  const handle = function handle(req: IncomingMessage, res: ServerResponse): void {
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
    if (viewers.isViewerPath(req.url)) {
      viewers.handleHttp(req, res, device);
      return;
    }
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
    if (isCloudDesktopAccess(method, path) && !device?.cloudDesktopAccess) {
      return sendJson(res, 403, {
        error: "cloud desktop access is off for this device — enable it in OpenMausBot → Settings → Remote access",
      });
    }

    const viewerClose = /^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/.exec(path);
    if (viewerClose && device?.id) viewers.close(device.id, viewerClose[1]);

    // Pairing terminates here. Forwarding it would hand the harness a route
    // it does not have, and the 404 would read to a phone as "wrong address".
    if (method === "POST" && path === "/api/pair") {
      readJson(req).then(
        (body) => {
          // New clients redeem the high-entropy credential carried by the QR.
          // `code` remains accepted for manual entry and older mobile builds.
          const result = options.redeem(
            String(body.credential ?? body.code ?? ""),
            body.deviceName,
            body.pairRequestId,
          );
          if ("error" in result) return sendJson(res, 401, { error: result.error });
          // `hosts` rides along whichever way the phone paired — QR, typed
          // address, or discovery — so every paired device learns the full
          // fallback list, not just the ones that scanned a QR. Absent, not
          // empty, when there is nothing to offer: absent is what a sidecar
          // predating the field sends, and one decode path beats two.
          const hosts = options.hosts?.() ?? [];
          const endpoints = options.endpoints?.() ?? [];
          const response: typeof result & {
            serverName: string;
            hosts?: string[];
            endpoints?: CompanionEndpoint[];
          } = {
            ...result,
            serverName: options.serverName(),
          };
          if (hosts.length) response.hosts = hosts;
          if (endpoints.length) response.endpoints = endpoints;
          return sendJson(res, 201, response);
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    // A paired phone refreshes connection candidates here after setup. This
    // is sidecar-owned state, so answer locally after the shared bearer and
    // default-deny checks above and never send it to the harness.
    if (method === "GET" && path === "/api/companion/endpoints") {
      return sendJson(res, 200, endpointSnapshot(options));
    }

    const mutationToken = device ? options.mutationToken?.() : undefined;
    if (device && options.mutationToken && !mutationToken) {
      return sendJson(res, 503, { error: "The desktop connection is starting. Please try again shortly." });
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.harnessPort,
        path: req.url,
        method,
        headers: forwardHeaders(req, device?.id, mutationToken ?? undefined),
      },
      (harness) => {
        clearTimeout(headersDeadline);
        // Keep liveness tied to the actual harness. Answering from the
        // sidecar alone made a dead bot server look healthy and caused the
        // desktop to advertise a hosted route that could not serve chats.
        // The harness response is inspected under a tiny bound, then replaced
        // completely so its pid/static fields never cross the public tunnel.
        if (method === "GET" && path === "/api/health") {
          const chunks: Buffer[] = [];
          let size = 0;
          let finished = false;
          const fail = () => {
            if (finished) return;
            finished = true;
            sendJson(res, 502, { error: "OpenMausBot is not ready on this computer" });
          };
          harness.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4_096) {
              harness.destroy();
              fail();
              return;
            }
            chunks.push(chunk);
          });
          harness.on("error", fail);
          harness.on("end", () => {
            if (finished) return;
            let identity: unknown;
            try {
              identity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              fail();
              return;
            }
            // SAFETY: identity came from untrusted JSON, and this assertion
            // grants no domain behavior; it permits one optional property
            // read whose value must equal a fixed literal before success.
            if (
              (harness.statusCode ?? 500) < 200 ||
              (harness.statusCode ?? 500) >= 300 ||
              (identity as { app?: unknown } | null)?.app !== "openmausbot"
            ) {
              fail();
              return;
            }
            finished = true;
            sendJson(res, 200, { app: "openmausbot" });
          });
          return;
        }

        const contentType = harness.headers["content-type"];
        const isStream = String(contentType ?? "").includes("text/event-stream");

        if (isStream) {
          const streamStatus = harness.statusCode ?? 500;
          const tracksDeviceConnection = method === "GET"
            && path === "/api/events"
            && streamStatus >= 200
            && streamStatus < 300
            && Boolean(device?.id);
          const currentDevice = tracksDeviceConnection ? options.authenticate(token) : device;
          if (tracksDeviceConnection && currentDevice?.id !== device?.id) {
            harness.destroy();
            return sendJson(res, 401, {
              error: "pair this device from Remote access settings on the host computer",
            });
          }
          const disconnect = () => {
            if (!harness.destroyed) harness.destroy();
            if (!res.destroyed) res.destroy();
          };
          let releaseConnection =
            tracksDeviceConnection && currentDevice?.id
              ? options.connected?.(currentDevice.id, disconnect) ?? null
              : null;
          const release = () => {
            releaseConnection?.();
            releaseConnection = null;
          };
          // Headers first and flushed, or nothing downstream believes the
          // connection is live. content-length is meaningless here and
          // content-encoding would be a lie once we rewrite the bytes.
          res.writeHead(harness.statusCode ?? 200, {
            "content-type": "text/event-stream",
            ...PRIVATE_RESPONSE_HEADERS,
            "cache-control": "private, no-store, no-transform",
            connection: "keep-alive",
            // Nagle would hold a small frame back waiting for company. On a
            // stream whose frames are small and whose whole value is being
            // timely, that is exactly wrong.
            "x-accel-buffering": "no",
          });
          res.flushHeaders?.();
          res.socket?.setNoDelay(true);
          // The harness writes an SSE keepalive every 25 seconds. TCP
          // keepalive covers the other direction so a vanished phone cannot
          // leave the desktop indicator green indefinitely on a half-open
          // connection.
          res.socket?.setKeepAlive(true, 30_000);

          const scrubStream = createSseScrubber();
          harness.setEncoding("utf8");
          harness.on("data", (chunk: string) => {
            let rewritten: string;
            try {
              rewritten = scrubStream(chunk);
            } catch {
              // The buffer ceiling. Half an event cannot be forwarded safely,
              // so the stream ends here rather than growing without bound.
              release();
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
          harness.on("end", () => {
            release();
            res.end();
          });
          harness.on("error", () => {
            release();
            res.destroy();
          });
          // A device that hangs up must take the upstream connection with
          // it, or the harness accumulates readers nobody is listening to.
          res.on("close", () => {
            release();
            harness.destroy();
          });
          return;
        }

        const encoding = String(harness.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        if (
          isMessageFileDownload(method, path)
          || !isJson(String(contentType ?? ""))
          || (encoding && encoding !== "identity")
        ) {
          // images and anything else: byte-for-byte, no parsing.
          //
          // Encoded bodies come through here too. Scrubbing one would mean
          // decompressing it, and the alternative the buffering branch would
          // otherwise reach — decode as UTF-8, re-serialise, drop the
          // content-encoding header — corrupts it silently. `forwardHeaders`
          // never sends accept-encoding, so this is a guard rather than a
          // path: if it ever fires, the body passes through unscrubbed and
          // intact rather than scrubbed and broken.
          res.writeHead(harness.statusCode ?? 200, privateHeaders(harness.headers));
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
            parsed = viewers.rewriteJoinResponse(path, parsed, device?.id);
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
            ...privateHeaders(headers),
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
    const headersTimeoutMs = proxyHeadersTimeoutMs(req.url ?? "", options.headersTimeoutMs);
    const headersDeadline = setTimeout(() => {
      timedOut = true;
      upstream.destroy(new Error("the harness sent no response headers"));
    }, headersTimeoutMs);
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

  handle.upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (req.headers.origin) {
      socket.destroy();
      return;
    }
    const token = bearerToken(req.headers.authorization);
    const device = options.authenticate(token);
    viewers.handleUpgrade(req, socket, head, device);
  };
  handle.disconnectDevice = (deviceId: string): void => viewers.closeDevice(deviceId);
  return handle;
}
