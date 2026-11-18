// The sidecar's end-to-end state: the transport key, the relay identity, the psk and admission value of every paired
// device and the open pairing window, and which device holds which live session over which route.
import type { Duplex } from "node:stream";

import { admission, admissionHash, credentialHash, credentialHashFromHex, keyId, psk } from "./credentials.ts";
import { descriptorFor, type E2EDescriptor } from "./descriptor.ts";
import { CLOSE, TRANSPORT_RELAY, type KeyPair, type PskCandidate, type TransportByte } from "./noise.ts";
import { E2ESession, type RecordTransport } from "./session.ts";

export type LiveRoute = "wifi" | "tailscale" | "relay";
/** A pairing peer carries the admission value its window had, so a relay session stays admitted after pairing. */
export type Peer = { kind: "device"; id: string } | { kind: "pairing"; admHash: string | null };

/** Shared by every stream of one session, so a pairing session becomes that device's once it has paired. */
export interface E2EContext {
  peer: Peer;
  route: LiveRoute;
}

export interface RelayIdentity {
  hostId: Buffer;
  nodes: string[];
}

/** The paired devices and open pairing windows: the sidecar's DeviceRegistry, or a server's sessions. A server keeps only
 * a pairing credential's SHA-256 (hex), so a window carries that or its token. */
export interface E2EDevices {
  records(): readonly { id: string; tokenHash: string; routes?: "any" | "local" }[];
  pairingWindows(): readonly ({ token: string } | { tokenHash: string })[];
  confirm(id: string): void;
  markE2E(id: string): void;
}

const windowHash = (window: { token: string } | { tokenHash: string }): Buffer | null =>
  "token" in window ? credentialHash(window.token) : credentialHashFromHex(window.tokenHash);

interface Live {
  session: E2ESession<Peer>;
  context: E2EContext;
  /** A relay session opened with a pairing token: kept in the admission set until it ends, or redeeming the window
   * would make the relay close the very session that paired. */
  pairingAdmission: string | null;
}

const ROUTE_RANK: Record<LiveRoute, number> = { wifi: 0, tailscale: 1, relay: 2 };
/** A session keyed by the pairing token may only pair; one that hasn't by then is closed. */
export const PAIRING_SESSION_MS = 150_000;
/** Handshakes in progress at once; more are refused until one finishes. */
export const MAX_PENDING_HANDSHAKES = 16;

export class E2ERegistry {
  readonly #devices: E2EDevices;
  readonly #live = new Set<Live>();
  #key: KeyPair | null = null;
  #relay: RelayIdentity | null = null;
  #pending = 0;
  readonly #admissionListeners = new Set<() => void>();
  /** Admission hashes kept a moment after their device lost the relay, so what the computer says inside the session
   * reaches the phone before the relay closes it. */
  readonly #held = new Map<string, number>();

  constructor(devices: E2EDevices) {
    this.#devices = devices;
  }

  /** The admission set may have changed for a reason the device registry doesn't see. */
  onAdmissionChange(listener: () => void): void {
    this.#admissionListeners.add(listener);
  }

  get enabled(): boolean {
    return this.#key !== null;
  }

  get relay(): RelayIdentity | null {
    return this.#relay;
  }

  setKey(key: KeyPair | null): void {
    this.#key = key;
    if (!key) this.closeAll(CLOSE.normal);
  }

  setRelay(relay: RelayIdentity | null): void {
    this.#relay = relay && relay.nodes.length > 0 ? relay : null;
  }

  /** Every device allowed on this transport, plus each open pairing window (at most 22). */
  candidates(transport: TransportByte): PskCandidate<Peer>[] {
    if (!this.#key) return [];
    const id = keyId(this.#key.publicKey);
    const out: PskCandidate<Peer>[] = [];
    for (const device of this.#devices.records()) {
      if (transport === TRANSPORT_RELAY && device.routes === "local") continue;
      const hash = credentialHashFromHex(device.tokenHash);
      if (hash) out.push({ id: { kind: "device", id: device.id }, psk: psk(hash, id) });
    }
    for (const window of this.#devices.pairingWindows()) {
      const hash = windowHash(window);
      if (!hash) continue;
      const admHash = this.#relay ? admissionHash(admission(hash, this.#relay.hostId)) : null;
      out.push({ id: { kind: "pairing", admHash }, psk: psk(hash, id) });
    }
    return out;
  }

  /** What the relay may admit: every device not restricted to Wi-Fi and Tailscale, and each open pairing window. */
  admissionSet(): string[] {
    if (!this.#relay) return [];
    const hostId = this.#relay.hostId;
    const out: string[] = [];
    for (const device of this.#devices.records()) {
      if (device.routes === "local") continue;
      const hash = credentialHashFromHex(device.tokenHash);
      if (hash) out.push(admissionHash(admission(hash, hostId)));
    }
    for (const window of this.#devices.pairingWindows()) {
      const hash = windowHash(window);
      if (hash) out.push(admissionHash(admission(hash, hostId)));
    }
    for (const live of this.#live) if (live.pairingAdmission) out.push(live.pairingAdmission);
    out.push(...this.#held.keys());
    return [...new Set(out)].sort();
  }

  /** Keeps this device admitted at the relay for `ms` whatever its routes now say, then lets the set shrink. */
  holdAdmission(deviceId: string, ms: number): Promise<void> {
    const device = this.#devices.records().find((candidate) => candidate.id === deviceId);
    const hash = device && this.#relay ? credentialHashFromHex(device.tokenHash) : null;
    if (!hash || !this.#relay) return Promise.resolve();
    const held = admissionHash(admission(hash, this.#relay.hostId));
    this.#held.set(held, (this.#held.get(held) ?? 0) + 1);
    return new Promise((resolve) => {
      setTimeout(() => {
        const count = (this.#held.get(held) ?? 1) - 1;
        if (count > 0) this.#held.set(held, count);
        else this.#held.delete(held);
        for (const listener of this.#admissionListeners) listener();
        resolve();
      }, ms).unref?.();
    });
  }

  /** For one device (null: a phone that is pairing now). A restricted device is told so, with the relay identity, which
   * admits nothing by itself: the relay refuses it until the device is allowed again. */
  descriptor(deviceId: string | null): E2EDescriptor | null {
    if (!this.#key) return null;
    const device = deviceId ? this.#devices.records().find((candidate) => candidate.id === deviceId) : null;
    return descriptorFor(this.#key.publicKey, this.#relay ?? undefined, device?.routes === "local" ? "local" : undefined);
  }

  /** One WebSocket that just opened, on a direct route or a relay data socket. Null when refused. */
  accept(
    transport: RecordTransport,
    transportByte: TransportByte,
    route: LiveRoute,
    connectOrigin: (context: E2EContext) => Promise<Duplex>,
  ): E2ESession<Peer> | null {
    const key = this.#key;
    if (!key || this.#pending >= MAX_PENDING_HANDSHAKES) {
      transport.close(CLOSE.rejected);
      return null;
    }
    this.#pending += 1;
    const live: Live = { context: { peer: { kind: "pairing", admHash: null }, route }, session: null as unknown as E2ESession<Peer>, pairingAdmission: null };
    live.session = E2ESession.computer<Peer>({
      transport,
      transportByte,
      staticKey: key,
      candidates: () => this.candidates(transportByte),
      connectOrigin: () => connectOrigin(live.context),
      opened: (peer) => {
        live.context.peer = peer;
        this.#live.add(live);
        if (peer.kind === "device") {
          this.#devices.confirm(peer.id);
          return this.#devices.markE2E(peer.id);
        }
        if (transportByte === TRANSPORT_RELAY) live.pairingAdmission = peer.admHash;
        const timer = setTimeout(() => {
          if (live.context.peer.kind === "pairing") live.session.close(CLOSE.rejected);
        }, PAIRING_SESSION_MS);
        timer.unref?.();
        void live.session.closed.then(() => clearTimeout(timer));
      },
    });
    let counted = true;
    const settle = () => {
      if (!counted) return;
      counted = false;
      this.#pending -= 1;
    };
    live.session.ready.then(settle, settle);
    void live.session.closed.then(() => {
      settle();
      this.#live.delete(live);
      if (live.pairingAdmission) for (const listener of this.#admissionListeners) listener();
    });
    return live.session;
  }

  /** A pairing session that redeemed the window now speaks for the new device. */
  paired(context: E2EContext, deviceId: string): void {
    context.peer = { kind: "device", id: deviceId };
    this.#devices.markE2E(deviceId);
  }

  /** Removal: the phone hears 4001 ("removed from your computer"). A narrowed route closes only relay sessions. */
  closeDevice(deviceId: string, code: number = CLOSE.rejected, onlyRoute?: LiveRoute): void {
    for (const live of this.#live) {
      if (live.context.peer.kind !== "device" || live.context.peer.id !== deviceId) continue;
      if (onlyRoute && live.context.route !== onlyRoute) continue;
      if (code === CLOSE.rejected) live.session.remove();
      else live.session.close(code);
    }
  }

  /** The best live route per device, for "Connected · Wi-Fi". */
  routes(): Record<string, LiveRoute> {
    const out: Record<string, LiveRoute> = {};
    for (const live of this.#live) {
      if (live.context.peer.kind !== "device" || live.session.state !== "open") continue;
      const current = out[live.context.peer.id];
      if (!current || ROUTE_RANK[live.context.route] < ROUTE_RANK[current]) out[live.context.peer.id] = live.context.route;
    }
    return out;
  }

  closeAll(code: number = CLOSE.normal): void {
    for (const live of this.#live) {
      if (code === CLOSE.normal) live.session.shutdown();
      else live.session.close(code);
    }
  }
}
