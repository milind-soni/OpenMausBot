// Wi-Fi and Tailscale: the phone dials ws://<host>:8810/v1/e2e on the device listener.
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { MAX_RECORD_BYTES, TRANSPORT_DIRECT } from "./noise.ts";
import type { E2EOrigin } from "./origin.ts";
import type { E2ERegistry, LiveRoute } from "./registry.ts";
import { acceptWebSocket } from "./ws-server.ts";

export const E2E_PATH = "/v1/e2e";
export const E2E_PROTOCOL = "omb-e2e.v1";

/** Tailscale's CGNAT range 100.64.0.0/10 and its IPv6 prefix fd7a:115c:a1e0::/48. */
export function routeFor(remoteAddress: string | undefined): LiveRoute {
  const address = (remoteAddress ?? "").replace(/^::ffff:/i, "").toLowerCase();
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127 ? "tailscale" : "wifi";
  }
  return address.startsWith("fd7a:115c:a1e0:") ? "tailscale" : "wifi";
}

export const isE2EUpgrade = (req: IncomingMessage): boolean => (req.url ?? "").split("?")[0] === E2E_PATH;

/** Refused outright while end-to-end is off, so a phone keeps to the routes it has. */
export function handleDirectUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, registry: E2ERegistry, origin: E2EOrigin): void {
  if (!registry.enabled) return void socket.destroy();
  const route = routeFor(req.socket.remoteAddress);
  acceptWebSocket(req, socket, head, { protocol: E2E_PROTOCOL, maxPayload: MAX_RECORD_BYTES }, (connection) => {
    const session = registry.accept(connection, TRANSPORT_DIRECT, route, (context) => origin.connect(context));
    return {
      message: (data, binary) => session?.receive(data, binary),
      close: (code) => session?.transportClosed(code),
    };
  });
}
