// A SOCKS5 server on loopback that a bot's Chrome sends every connection through. It resolves names itself and
// connects only to addresses its policy allows, so neither redirects nor DNS rebinding reach anything else, and it
// carries bytes only: TLS, HTTP/2 and WebSockets pass through unchanged. A public destination the caller picks may go
// out through an upstream instead, the person's own computer, which resolves and checks it there.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/htmlRender/publicProxy.ts, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: plain Node in place of Effect, the policy is
// the caller's and every refusal is reported, localhost names resolve here as Chrome resolves them, a failed
// upstream connection gets a SOCKS reply, and a connection may go out through an upstream.
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type BlockList, type Socket } from "node:net";

import type { LinkOpened } from "../../../electron/device-link-protocol.mjs";
import { addressClass, namesThisMachine, ownAddresses } from "./policy.ts";

export interface ResolvedAddress { address: string; family: number }
export interface GateTarget { host: string; port: number }

/** Another way out for one connection: the person's own computer, which looks the name up and checks it itself. */
export interface GateUpstream { open(target: GateTarget): Promise<LinkOpened> }

export interface GateOptions {
  /** Why a destination is refused by its name alone, or null; a name refused here is never looked up. */
  refuseName?(target: GateTarget): string | null;
  /** Why the connection is refused, or null to connect to exactly these addresses. */
  decide(target: GateTarget, addresses: readonly ResolvedAddress[]): Promise<string | null>;
  onRefusal?(target: GateTarget, reason: string): void;
  resolve?(host: string): Promise<ResolvedAddress[]>;
  /** Decided per connection, after the name check, for a public destination only; one that ends before it answers
   * goes the gate's own way. */
  upstream?(target: GateTarget): GateUpstream | null;
  /** A configured unauthenticated SOCKS5 proxy for public destinations after the local destination policy passes. */
  upstreamProxy?: () => { host: string; port: number } | null;
  /** This machine's own addresses, which never go upstream: its interfaces unless a test passes them. */
  own?(): BlockList;
}

export interface EgressGate {
  port: number;
  close(): Promise<void>;
}

/** A Chrome OpenMausBot starts never touches the person's credential store: on macOS Chrome otherwise opens the login
 * keychain (a dialog when it cannot find one), and on Linux it asks the desktop keyring. */
export function credentialStoreFlags(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["--use-mock-keychain"] : platform === "linux" ? ["--password-store=basic"] : [];
}

/** How a whole Chrome goes through the gate on `port`. */
export function gateChromeSettings(port: number, platform: NodeJS.Platform = process.platform): { proxy: string; bypass: string; args: string[] } {
  return {
    proxy: `socks5://127.0.0.1:${port}`,
    // Chrome otherwise connects to loopback directly.
    bypass: "<-loopback>",
    args: [
      // WebRTC would otherwise send UDP around the proxy. Chrome 155 reads the first switch and
      // chrome-headless-shell 153 the second; each ignores the other.
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ...credentialStoreFlags(platform),
    ],
  };
}

export function gateChromeFlags(port: number, platform: NodeJS.Platform = process.platform): string[] {
  const settings = gateChromeSettings(port, platform);
  return [`--proxy-server=${settings.proxy}`, `--proxy-bypass-list=${settings.bypass}`, ...settings.args];
}

const LOOPBACK_NAMES: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }];

/** Chrome sends names, address literals included, for the proxy to resolve. */
export async function resolveTarget(host: string): Promise<ResolvedAddress[]> {
  const literal = isIP(host);
  if (literal) return [{ address: host, family: literal }];
  if (namesThisMachine(host)) return LOOPBACK_NAMES;
  return lookup(host, { all: true, verbatim: true }).catch(() => []);
}

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, connection refused, command unsupported.
const SUCCEEDED = 0;
const NOT_ALLOWED = 2;
const HOST_UNREACHABLE = 4;
const CONNECTION_REFUSED = 5;
const UNSUPPORTED = 7;
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// What a client may send before its tunnel opens; a TLS hello fits easily.
const MAX_EARLY_BYTES = 64 * 1024;

function socksAddress(host: string): Buffer {
  const kind = isIP(host);
  if (kind === 4) return Buffer.concat([Buffer.from([1]), Buffer.from(host.split(".").map(Number))]);
  if (kind === 6) {
    const [head = "", tail = ""] = host.split("::");
    const groupsFor = (part: string) => {
      const groups = part ? part.split(":") : [];
      const last = groups.at(-1);
      if (last?.includes(".")) {
        const octets = last.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) throw new Error("The checked proxy destination is not a valid IP address.");
        groups.splice(-1, 1, ((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
      }
      return groups;
    };
    const left = groupsFor(head);
    const right = groupsFor(tail);
    const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    const address = Buffer.alloc(16);
    groups.forEach((group, index) => address.writeUInt16BE(Number.parseInt(group, 16), index * 2));
    return Buffer.concat([Buffer.from([4]), address]);
  }
  throw new Error("The checked proxy destination is not an IP address.");
}

/** Open a no-auth SOCKS5 tunnel to a numeric, already policy-checked destination. */
async function connectSocks5(proxy: { host: string; port: number }, target: GateTarget): Promise<Socket> {
  const socket = connect({ host: proxy.host, port: proxy.port });
  socket.on("error", () => {});
  socket.setTimeout(10_000, () => socket.destroy(new Error("SOCKS5 proxy handshake timed out.")));
  let pending = Buffer.alloc(0);
  const readAtLeast = (size: number): Promise<Buffer> => new Promise((resolve, reject) => {
    const cleanup = () => { socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("SOCKS5 proxy closed during handshake.")); };
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= size) {
        cleanup();
        const result = pending.subarray(0, size);
        pending = pending.subarray(size);
        resolve(result);
      }
    };
    if (pending.length >= size) {
      const result = pending.subarray(0, size);
      pending = pending.subarray(size);
      resolve(result);
      return;
    }
    socket.on("data", onData); socket.once("error", onError); socket.once("close", onClose);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve); socket.once("error", reject);
    });
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await readAtLeast(2);
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("SOCKS5 proxy must allow connections without authentication.");
    const address = socksAddress(target.host);
    const port = Buffer.alloc(2); port.writeUInt16BE(target.port);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, port]));
    const head = await readAtLeast(4);
    const domainLength = head[3] === 3 ? await readAtLeast(1) : null;
    const length = head[3] === 1 ? 4 : head[3] === 4 ? 16 : domainLength?.[0] ?? 0;
    if (!length) throw new Error("SOCKS5 proxy returned an invalid response.");
    await readAtLeast(length + 2);
    if (head[1] !== 0) throw Object.assign(new Error("SOCKS5 proxy refused the connection."), { code: head[1] === 2 ? "EACCES" : "ECONNREFUSED" });
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** A name for this machine, or an address that is not on the public internet: always the gate's own way, under its own
 * policy, so a bot's dev server here stays reachable and nothing private is asked of the person's computer. */
export function staysHere(host: string, own: BlockList = ownAddresses()): boolean {
  if (/^(?:[^.]+\.)*localhost\.?$/i.test(host)) return true;
  return isIP(host) !== 0 && addressClass(host, own) !== "public";
}

/** Answers and closes; whatever the client sent after its request is dropped, not left buffered. */
function refuse(client: Socket, code: number): void {
  client.end(reply(code), () => client.destroy());
}

/** The CONNECT target in a complete SOCKS5 request, or "short" while more bytes are needed. */
function readRequest(data: Buffer) {
  if (data.length < 5) return "short" as const;
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host = type === 1
    ? [...data.subarray(4, 8)].join(".")
    : type === 3
      ? data.subarray(5, 5 + data[4]!).toString("latin1")
      : Array.from({ length: 8 }, (_, index) => data.readUInt16BE(4 + index * 2).toString(16)).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
}

/** Listens on an ephemeral loopback port until closed; a gate that is not running fails every connection. */
export function openGate(options: GateOptions): Promise<EgressGate> {
  const resolve = options.resolve ?? resolveTarget;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    let data = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        // Version 5, offering "no authentication".
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) return void client.end(Buffer.from([5, 0xff]));
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(data);
      if (request === "short") return;
      client.off("data", onData);
      if (request === undefined || request.command !== 1 || request.port === 0) return refuse(client, UNSUPPORTED);
      const target = { host: request.host, port: request.port };
      // Keeps reading while the target resolves, so a client that leaves is noticed, and holds what it sends early.
      const early: Buffer[] = [request.rest];
      let earlyBytes = request.rest.length;
      const holdEarly = (chunk: Buffer) => {
        earlyBytes += chunk.length;
        if (earlyBytes > MAX_EARLY_BYTES) return void client.destroy();
        early.push(chunk);
      };
      client.on("data", holdEarly);
      void (async () => {
        const named = options.refuseName?.(target) ?? null;
        const through = named === null && !staysHere(target.host, options.own?.()) ? options.upstream?.(target) ?? null : null;
        if (through) {
          const opened = await through.open(target).catch((): LinkOpened => ({ gone: true }));
          if (!("gone" in opened)) {
            if (client.destroyed) return void ("cancel" in opened && opened.cancel());
            client.off("data", holdEarly);
            if ("refused" in opened) {
              options.onRefusal?.(target, opened.refused);
              return refuse(client, NOT_ALLOWED);
            }
            if ("failed" in opened) return refuse(client, opened.failed === "refused" ? CONNECTION_REFUSED : HOST_UNREACHABLE);
            client.write(reply(SUCCEEDED));
            opened.join(client, early);
            return;
          }
          if (client.destroyed) return;
        }
        const addresses = named === null ? await resolve(target.host) : [];
        const refusal = named ?? (addresses.length ? await options.decide(target, addresses).catch(() => "error") : null);
        if (client.destroyed) return;
        client.off("data", holdEarly);
        if (refusal !== null) {
          options.onRefusal?.(target, refusal);
          return refuse(client, NOT_ALLOWED);
        }
        if (!addresses.length) return refuse(client, HOST_UNREACHABLE);
        const own = options.own?.();
        const publicTarget = addresses.every(({ address }) => addressClass(address, own) === "public");
        const configuredProxy = options.upstreamProxy?.() ?? null;
        const proxy = configuredProxy && publicTarget && !staysHere(target.host, own) ? configuredProxy : null;
        if (proxy) {
          let tunnel: Socket;
          try {
            // The proxy receives the exact IPs checked above, not a hostname it could resolve differently.
            tunnel = await connectSocks5(proxy, { host: addresses[0]!.address, port: target.port });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EACCES") return refuse(client, NOT_ALLOWED);
            return refuse(client, code === "ECONNREFUSED" ? CONNECTION_REFUSED : HOST_UNREACHABLE);
          }
          if (client.destroyed) return void tunnel.destroy();
          client.off("data", holdEarly);
          client.write(reply(SUCCEEDED));
          for (const chunk of early) tunnel.write(chunk);
          tunnel.pipe(client);
          client.pipe(tunnel);
          tunnel.on("error", () => client.destroy());
          client.on("close", () => tunnel.destroy());
          tunnel.on("close", () => client.destroy());
          return;
        }
        client.pause();
        // Every checked address, IPv6 and IPv4 alike, so a host is still reached where one family is broken; the
        // lookup hands back only checked addresses, so a name that now resolves elsewhere changes nothing.
        const upstream = track(connect({
          host: target.host,
          port: target.port,
          autoSelectFamily: true,
          lookup: (_host, lookupOptions, callback) => lookupOptions.all
            ? callback(null, addresses)
            : callback(null, addresses[0]!.address, addresses[0]!.family),
        }));
        let connected = false;
        upstream.once("connect", () => {
          connected = true;
          client.write(reply(SUCCEEDED));
          for (const chunk of early) upstream.write(chunk);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.once("error", () => { if (!connected && !client.destroyed) refuse(client, CONNECTION_REFUSED); });
        upstream.on("close", () => { if (connected) client.destroy(); });
        client.on("close", () => upstream.destroy());
      })().catch(() => client.destroy());
    };
    client.on("data", onData);
  });
  return new Promise((done, fail) => {
    // A failure to listen fails this browser; once listening, a server error must not reach Node unhandled.
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      server.on("error", () => {});
      const address = server.address();
      done({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () => new Promise<void>((closed) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => closed());
        }),
      });
    });
  });
}
