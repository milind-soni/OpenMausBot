// The reference phone: dials a route with Node's built-in WebSocket client and returns an open session. Used by the
// interop and integration tests, and by a desktop reaching another desktop.
import { b64u } from "./credentials.ts";
import { E2ESession, SEND_BUFFER_HIGH, SessionClosed, type RecordTransport } from "./session.ts";
import { HANDSHAKE_DEADLINE_MS, TRANSPORT_RELAY, type KeyPair, type TransportByte } from "./noise.ts";

export const DIRECT_PROTOCOL = "omb-e2e.v1";
export const RELAY_PROTOCOL = "omb-relay.v1";
const DRAIN_POLL_MS = 5;

export interface DialOptions {
  /** `ws://host:port/v1/e2e` for Wi-Fi and Tailscale, `wss://relayN.openmausbot.com/v1/phone` for the relay. */
  url: string;
  transportByte: TransportByte;
  remoteStatic: Uint8Array;
  psk: Uint8Array;
  app: string;
  /** On the relay: the hostId and this device's admission value, sent before the handshake. */
  relay?: { hostId: Uint8Array; adm: Uint8Array };
  timeoutMs?: number;
  /** Test-only. */
  ephemeral?: KeyPair;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

/** Codes a WebSocket client may send; any other closes without one. */
const sendable = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

function transportFor(socket: WebSocket): RecordTransport {
  return {
    send: (message) => socket.send(message),
    close: (code, reason) => (sendable(code) ? socket.close(code, reason) : socket.close()),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    // The built-in client has no drain event.
    onceDrained(listener) {
      const check = () => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount <= SEND_BUFFER_HIGH / 4) listener();
        else setTimeout(check, DRAIN_POLL_MS);
      };
      check();
    },
  };
}

/** Rejects with SessionClosed (the close code, e.g. 4001 or a relay 4404) or a NoiseError (a hard stop). */
export function dial(options: DialOptions): Promise<E2ESession<never>> {
  const relayed = Boolean(options.relay);
  if (relayed && options.transportByte !== TRANSPORT_RELAY) throw new Error("the relay route uses the relay prologue");
  const socket = new WebSocket(options.url, [relayed ? RELAY_PROTOCOL : DIRECT_PROTOCOL]);
  socket.binaryType = "arraybuffer";
  const transport = transportFor(socket);
  return new Promise((resolve, reject) => {
    let session: E2ESession<never> | null = null;
    const timer = setTimeout(() => {
      reject(new SessionClosed(4002));
      socket.close();
    }, (options.timeoutMs ?? HANDSHAKE_DEADLINE_MS) + (relayed ? 10_000 : 0));
    const start = () => {
      session = E2ESession.phone({ ...options, transport });
      session.ready.then(
        () => {
          clearTimeout(timer);
          resolve(session as E2ESession<never>);
        },
        (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    };
    socket.onopen = () => {
      if (!options.relay) return start();
      socket.send(JSON.stringify({ t: "phone", v: 1, hid: b64u(options.relay.hostId), adm: b64u(options.relay.adm) }));
    };
    socket.onmessage = (event: MessageEvent) => {
      const binary = typeof event.data !== "string";
      const data = binary ? new Uint8Array(event.data as ArrayBuffer) : Buffer.from(event.data as string, "utf8");
      if (session) return session.receive(data, binary);
      // Before the session: only the relay's ready.
      let ready = false;
      try {
        ready = !binary && (JSON.parse(String(event.data)) as { t?: unknown }).t === "ready";
      } catch {
        ready = false;
      }
      if (!ready) {
        clearTimeout(timer);
        reject(new SessionClosed(4400));
        return socket.close();
      }
      start();
    };
    socket.onclose = (event: CloseEvent) => {
      clearTimeout(timer);
      if (session) session.transportClosed(event.code);
      else reject(new SessionClosed(event.code));
    };
    socket.onerror = () => {};
  });
}
