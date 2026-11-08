// The forwarding half of the sidecar. The harness serves only a loopback Host
// (a DNS-rebinding defence), so a device's request is replayed to 127.0.0.1
// as this process, never with the device's Host or Origin.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { bearerToken } from "./devices.ts";
import type { E2EDescriptor } from "./e2e/descriptor.ts";
import { e2eContextOf } from "./e2e/origin.ts";
import type { E2EContext } from "./e2e/registry.ts";
import {
  COMPANION_ENDPOINT_KINDS,
  MAX_COMPANION_ENDPOINTS,
  type CompanionEndpoint,
} from "./endpoints.ts";
import {
  denyReason,
  isBrowserControlAccess,
  isCloudDesktopAccess,
  isMessageFileDownload,
} from "./routes.ts";
import { sendTunnelJson } from "./tunnel-gzip.ts";
import { CompanionViewerRelay, requestTarget } from "./viewer-relay.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";

export interface ProxyOptions {
  harnessPort: number;
  /** null: bootstrap is not ready yet; undefined: a plain Node harness. */
  mutationToken?: () => string | null;
  authenticate: (
    token: string | undefined,
  ) => { id?: string; cloudDesktopAccess: boolean; browserControlAccess: boolean; e2eAt?: number } | null;
  /** Pairing is handled here and never forwarded: the harness has no such route. */
  redeem: (
    code: string,
    deviceName: unknown,
    pairRequestId?: unknown,
  ) => { token: string; device: unknown } | { error: string };
  serverName: () => string;
  /** Every host the phone could dial later, best first, sent with the pairing
   * response as an advisory fallback list. */
  hosts?: () => string[];
  /** Complete connection URLs for mobile clients. */
  endpoints?: () => CompanionEndpoint[];
  /** Register one authenticated, live event stream. The tracker can terminate
   * it synchronously on revoke; the returned disposer is called exactly once. */
  connected?: (deviceId: string, disconnect: () => void) => () => void;
  headersTimeoutMs?: number;
  /** The `e2e` descriptor for one device (null: the phone pairing now); null when end-to-end is off. */
  e2eDescriptor?: (deviceId: string | null) => E2EDescriptor | null;
  /** A phone paired through an encrypted session keyed by the pairing token: the session is now that device's. */
  e2ePaired?: (context: E2EContext, deviceId: string) => void;
}

/** Which listener a request reached. Only `lan` (port 8810, plain HTTP) refuses a device that has gone end-to-end;
 * requests arriving through an encrypted stream are recognised by their socket, whatever this says. */
export type ProxyListener = "lan" | "origin";

/** §11 rule 4 of the wire spec: a phone that has used the encrypted connection never goes back to plain HTTP. */
const UPDATE_APP = { error: "update_app" } as const;

const PAIRING_SESSION_PATHS = new Set(["POST /api/pair", "GET /api/health"]);

/** A token presented inside a session must belong to the device whose psk opened it. */
function e2eRefusal(context: E2EContext, method: string, path: string, deviceId: string | undefined): string | null {
  if (context.peer.kind === "pairing") return PAIRING_SESSION_PATHS.has(`${method} ${path}`) ? null : "pair this phone first";
  return deviceId && deviceId !== context.peer.id ? "this connection belongs to another device" : null;
}

export interface CompanionEndpointSnapshot {
  serverName: string;
  endpoints: CompanionEndpoint[];
}

/** Headers only: an SSE stream deliberately never ends, so the body has no
 * deadline. */
const HEADERS_TIMEOUT_MS = 30_000;
// Must outlast the server's 90-second private-save deadline and stay inside
// the hosted proxy's.
const PHONE_SECRET_HEADERS_TIMEOUT_MS = 105_000;
const PHONE_SECRET_PROVIDE_PATH = /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/provide(?:\?|$)/;

export function proxyHeadersTimeoutMs(url: string, override?: number): number {
  return override
    ?? (PHONE_SECRET_PROVIDE_PATH.test(url) ? PHONE_SECRET_HEADERS_TIMEOUT_MS : HEADERS_TIMEOUT_MS);
}

const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/** Bounded: an unbounded read on an unauthenticated route is a
 * memory-exhaustion vector. */
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

const isPlainValue = (value: unknown): value is string | number | null | undefined =>
  value == null || typeof value === "string" || typeof value === "number";

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  pragma: "no-cache",
  vary: "Authorization",
} as const;

/** Responses can cross a public CDN on the managed HTTPS endpoint, so none may
 * become a shared cache entry. Overrides the harness's own headers. */
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
  const headers = { "content-type": "application/json", ...PRIVATE_RESPONSE_HEADERS };
  if (sendTunnelJson(res, status, headers, text)) return;
  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(text) });
  res.end(text);
};

/** Validated and capped at the network boundary so no producer can publish an
 * extra field, a path-bearing URL or an unbounded list. */
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

export function companionIdentityHeaders(authenticatedDeviceId?: string, mutationToken?: string): Record<string, string> {
  const out: Record<string, string> = {
    // Carries no authority; it only narrows behavior at the harness.
    "x-openmausbot-companion": "1",
  };
  // Never a caller-supplied header: this id comes only from the registry entry
  // that authenticated the bearer.
  if (authenticatedDeviceId && /^[\w-]{1,128}$/.test(authenticatedDeviceId)) {
    out["x-openmausbot-companion-device"] = authenticatedDeviceId;
    if (mutationToken) out["x-openmausbot-companion-auth"] = mutationToken;
  }
  return out;
}

/** An allowlist: `host` and `origin` must not travel, `authorization` is the
 * sidecar's own credential, and hop-by-hop headers are not ours to relay. */
const forwardHeaders = (req: IncomingMessage, authenticatedDeviceId?: string, mutationToken?: string): Record<string, string> => {
  const out: Record<string, string> = {
    accept: String(req.headers.accept ?? "*/*"),
    ...companionIdentityHeaders(authenticatedDeviceId, mutationToken),
  };
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  // A trustworthy byte count lets the harness reserve disk quota up front.
  const contentLength = req.headers["content-length"];
  if (
    typeof contentLength === "string"
    && /^(?:0|[1-9]\d*)$/.test(contentLength)
    && Number.isSafeInteger(Number(contentLength))
  ) {
    out["content-length"] = contentLength;
  }
  // Last-Event-ID lets a reconnecting client resume instead of re-hydrating.
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) out["last-event-id"] = String(lastEventId);
  // Only canonical single-range shapes travel; anything else gets the
  // complete file.
  const range = req.headers.range;
  if (typeof range === "string") {
    const canonical = range.trim();
    if (/^bytes=\d*-\d*$/.test(canonical)) out.range = canonical;
  }
  return out;
};

/** Read-only (`action: "check"`); every failure is "no". */
function harnessControlCheck(options: ProxyOptions) {
  return (deviceId: string, botId: string, controlLeaseId: string): Promise<boolean> => new Promise((resolve) => {
    const mutationToken = options.mutationToken?.();
    if (options.mutationToken && !mutationToken) return resolve(false);
    const body = JSON.stringify({ action: "check", controlLeaseId });
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-openmausbot-companion": "1",
      "x-openmausbot-companion-device": deviceId,
    };
    if (mutationToken) headers["x-openmausbot-companion-auth"] = mutationToken;
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: options.harnessPort,
      path: `/api/bots/${encodeURIComponent(botId)}/computer/control`,
      method: "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) return request.destroy();
        chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { owned?: unknown };
          resolve(response.statusCode === 200 && parsed.owned === true);
        } catch {
          resolve(false);
        }
      });
      response.once("error", () => resolve(false));
    });
    request.setTimeout(5_000, () => request.destroy());
    request.once("error", () => resolve(false));
    request.end(body);
  });
}

export function createProxyHandler(options: ProxyOptions) {
  const viewers = new CompanionViewerRelay({ checkControl: harnessControlCheck(options) });
  const capabilityStreams = new Map<string, Set<() => void>>();
  /** Each device's open `/api/events` streams, for the events the sidecar itself sends. */
  const eventStreams = new Map<string, Set<(event: string) => void>>();
  const endpointsFor = (deviceId: string | null) => {
    const descriptor = options.e2eDescriptor?.(deviceId) ?? null;
    return { ...endpointSnapshot(options), ...(descriptor ? { e2e: descriptor } : {}) };
  };
  const handle = function handle(req: IncomingMessage, res: ServerResponse, listener: ProxyListener = "lan"): void {
    const target = requestTarget(req.url);
    if (!target) return sendJson(res, 400, { error: "invalid request target" });
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    // A native app sends no Origin: anything with one is a browser, refused
    // before the token is looked at.
    if (req.headers.origin) {
      return sendJson(res, 403, { error: "forbidden: cross-origin request" });
    }

    const token = bearerToken(req.headers.authorization);
    const device = options.authenticate(token);
    const e2e = e2eContextOf(req.socket);
    if (!e2e && listener === "lan" && device?.e2eAt && path !== "/api/health") return sendJson(res, 426, UPDATE_APP);
    const e2eDenial = e2e ? e2eRefusal(e2e, method, path, device?.id) : null;
    if (e2eDenial) return sendJson(res, 401, { error: e2eDenial });
    const browserRequest = isBrowserControlAccess(method, path);
    const browserRefusal = () => {
      if (!browserRequest) return null;
      const current = options.authenticate(token);
      if (!current || current.id !== device?.id) {
        return { status: 401, error: "pair this device from Remote access settings on the host computer" };
      }
      return current.browserControlAccess ? null : {
        status: 403,
        error: "browser control is off for this device — enable it in Remote access settings on the host computer",
      };
    };
    if (viewers.isViewerPath(req.url)) {
      viewers.handleHttp(req, res, device);
      return;
    }
    const denial = denyReason({
      path,
      method,
      authenticated: Boolean(device),
    });
    if (denial) return sendJson(res, denial.status, { error: denial.error });

    // Pairing grants the ordinary companion surface, not a computer's browser
    // session; the owner enables this per device, off by default.
    if (isCloudDesktopAccess(method, path) && !device?.cloudDesktopAccess) {
      return sendJson(res, 403, {
        error: "computer access is off for this device — enable it in OpenMausBot → Settings → Remote access",
      });
    }

    // A separate grant: this browser is normally signed into the person's own accounts.
    if (isBrowserControlAccess(method, path) && !device?.browserControlAccess) {
      return sendJson(res, 403, {
        error: "browser control is off for this device — open Remote access on the computer and turn on \"Allow browser control\" for it",
      });
    }

    const viewerClose = /^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/.exec(path);
    if (viewerClose && device?.id) viewers.close(device.id, viewerClose[1]);

    if (method === "POST" && path === "/api/pair") {
      readJson(req).then(
        (body) => {
          const credential = body.credential ?? body.code;
          if (!isPlainValue(credential) || !isPlainValue(body.deviceName)) {
            return sendJson(res, 400, { error: "invalid pairing request" });
          }
          const result = options.redeem(
            String(credential ?? ""),
            body.deviceName,
            body.pairRequestId,
          );
          if ("error" in result) return sendJson(res, 401, { error: result.error });
          const pairedId = (result.device as { id?: unknown } | null)?.id;
          if (e2e && typeof pairedId === "string") options.e2ePaired?.(e2e, pairedId);
          const hosts = options.hosts?.() ?? [];
          const endpoints = options.endpoints?.() ?? [];
          const descriptor = options.e2eDescriptor?.(typeof pairedId === "string" ? pairedId : null) ?? null;
          const response: typeof result & {
            serverName: string;
            hosts?: string[];
            endpoints?: CompanionEndpoint[];
            e2e?: E2EDescriptor;
          } = {
            ...result,
            serverName: options.serverName(),
          };
          if (hosts.length) response.hosts = hosts;
          if (endpoints.length) response.endpoints = endpoints;
          if (descriptor) response.e2e = descriptor;
          return sendJson(res, 201, response);
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      ).catch((error: unknown) => {
        console.error("companion: pairing failed", error);
        sendJson(res, 500, { error: "could not complete the pairing" });
      });
      return;
    }

    // Sidecar-owned state: answered here after the bearer and default-deny
    // checks, never sent to the harness.
    if (method === "GET" && path === "/api/companion/endpoints") {
      return sendJson(res, 200, endpointsFor(device?.id ?? null));
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
        // A grant revoked while the native browser opens must not expose frames.
        const refusal = browserRefusal();
        if (refusal) {
          harness.destroy();
          return sendJson(res, refusal.status, { error: refusal.error });
        }
        // Health comes from the harness, read under a tiny bound and replaced
        // whole so its pid/static fields never cross the public tunnel.
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
            // SAFETY: identity is untrusted JSON; the assertion only permits
            // reading one optional property compared to a fixed literal.
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
          // Capability-only streams must close when the capability is revoked;
          // `connected` covers only /api/events.
          const capabilityOwner = isBrowserControlAccess(method, path) ? device?.id : undefined;
          if (capabilityOwner) {
            const open = capabilityStreams.get(capabilityOwner) ?? new Set<() => void>();
            open.add(disconnect);
            capabilityStreams.set(capabilityOwner, open);
          }
          // The scrubber hands on whole events only, so an event written here never splits one of the harness's.
          const pushTo = tracksDeviceConnection && currentDevice?.id ? currentDevice.id : undefined;
          const push = (event: string) => {
            if (!res.destroyed && !res.writableEnded) res.write(event);
          };
          if (pushTo) {
            const open = eventStreams.get(pushTo) ?? new Set<(event: string) => void>();
            open.add(push);
            eventStreams.set(pushTo, open);
          }
          const release = () => {
            releaseConnection?.();
            releaseConnection = null;
            if (pushTo) {
              const open = eventStreams.get(pushTo);
              open?.delete(push);
              if (open && open.size === 0) eventStreams.delete(pushTo);
            }
            if (capabilityOwner) {
              const open = capabilityStreams.get(capabilityOwner);
              open?.delete(disconnect);
              if (open && open.size === 0) capabilityStreams.delete(capabilityOwner);
            }
          };
          // content-length is meaningless here, and content-encoding would be a
          // lie once the bytes are rewritten.
          res.writeHead(harness.statusCode ?? 200, {
            "content-type": "text/event-stream",
            ...PRIVATE_RESPONSE_HEADERS,
            "cache-control": "private, no-store, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.flushHeaders?.();
          res.socket?.setNoDelay(true);
          // TCP keepalive, so a vanished phone cannot leave the desktop
          // indicator green on a half-open connection.
          res.socket?.setKeepAlive(true, 30_000);

          const scrubStream = createSseScrubber();
          harness.setEncoding("utf8");
          harness.on("data", (chunk: string) => {
            let rewritten: string;
            try {
              rewritten = scrubStream(chunk);
            } catch {
              // Over the buffer ceiling: half an event cannot be forwarded safely.
              release();
              harness.destroy();
              res.end();
              return;
            }
            if (!rewritten) return;
            // Backpressure, or a slow phone buffers unbounded in this process.
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
          // Otherwise the harness accumulates readers nobody is listening to.
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
          // Byte-for-byte, unscrubbed. forwardHeaders never sends
          // accept-encoding, so an encoded body arriving here passes through
          // intact rather than scrubbed and broken.
          res.writeHead(harness.statusCode ?? 200, privateHeaders(harness.headers));
          // `pipe` does not carry a source failure to the destination; without
          // this a half-sent body leaves the phone waiting forever.
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
          const refusal = browserRefusal();
          if (refusal) return sendJson(res, refusal.status, { error: refusal.error });
          const body = Buffer.concat(chunks).toString("utf8");

          // A body that does not parse was never JSON (or an empty 204):
          // forward it verbatim.
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            forward(body, harness.headers, harness.statusCode ?? 200);
            return;
          }

          // A body that parses but will not scrub must not fall back to raw:
          // scrub keeps the resume cursors off the wire, and it recurses, so
          // deep nesting throws RangeError where JSON.parse does not.
          let text: string;
          try {
            parsed = viewers.rewriteJoinResponse(
              path,
              parsed,
              device?.id,
              target.searchParams.get("controlLeaseId"),
            );
            text = JSON.stringify(scrub(parsed));
          } catch {
            sendJson(res, 502, { error: "the response could not be prepared for this device" });
            return;
          }
          forward(text, harness.headers, harness.statusCode ?? 200);
        });

        /** The body was re-serialised, so the harness's framing headers are
         * dropped: Node's parser rejects transfer-encoding alongside
         * content-length. */
        function forward(text: string, upstreamHeaders: IncomingMessage["headers"], status: number): void {
          const headers = { ...upstreamHeaders };
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          const reply = privateHeaders(headers);
          if (sendTunnelJson(res, status, reply, text)) return;
          res.writeHead(status, { ...reply, "content-length": Buffer.byteLength(text) });
          res.end(text);
        }
      },
    );

    // Tear down the upstream whenever the phone goes away; guarded on
    // `writableEnded` so a finished response keeps its keep-alive socket.
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());

    // `http.request` has no deadline of its own for the headers phase.
    let timedOut = false;
    const headersTimeoutMs = proxyHeadersTimeoutMs(req.url ?? "", options.headersTimeoutMs);
    const headersDeadline = setTimeout(() => {
      timedOut = true;
      upstream.destroy(new Error("the harness sent no response headers"));
    }, headersTimeoutMs);
    headersDeadline.unref?.();

    upstream.on("error", () => {
      clearTimeout(headersDeadline);
      // Headers already sent: writeHead would throw ERR_HTTP_HEADERS_SENT out
      // of an event handler and take the sidecar down, so drop the socket.
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

  handle.upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, listener: ProxyListener = "lan"): void => {
    if (req.headers.origin) {
      socket.destroy();
      return;
    }
    const token = bearerToken(req.headers.authorization);
    const device = options.authenticate(token);
    const e2e = e2eContextOf(req.socket);
    if (!e2e && listener === "lan" && device?.e2eAt) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (e2e && e2eRefusal(e2e, req.method ?? "GET", (req.url ?? "/").split("?")[0], device?.id)) {
      socket.destroy();
      return;
    }
    viewers.handleUpgrade(req, socket, head, device);
  };
  handle.closeViewers = (): void => viewers.closeAll();
  /** The endpoint list again, as an event on every event stream the device holds: a phone hears a change of where it
   * may connect from inside its session, before the relay acts on it. No `id:`, so the replay cursor stays put. */
  handle.sendEndpoints = (deviceId: string): number => {
    const open = eventStreams.get(deviceId);
    if (!open) return 0;
    const event = `data: ${JSON.stringify({ kind: "companion.endpoints", ...endpointsFor(deviceId) })}\n\n`;
    for (const push of open) push(event);
    return open.size;
  };
  handle.disconnectDevice = (deviceId: string): void => {
    viewers.closeDevice(deviceId);
    // Revoking a capability closes the streams it already granted.
    const open = capabilityStreams.get(deviceId);
    if (!open) return;
    capabilityStreams.delete(deviceId);
    for (const close of open) close();
  };
  return handle;
}
