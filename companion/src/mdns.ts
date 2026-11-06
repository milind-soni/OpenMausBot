// mDNS / DNS-SD responder (RFC 6762/6763), answer-only: it neither browses
// nor probes for name conflicts (§8.1).
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

import { lanInterfaces } from "./listener.ts";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
/** RFC 6762 §10: host records are short-lived, service records are not. */
const TTL_HOST = 120;
const TTL_SERVICE = 4500;
/** RFC 6762 §11 — multicast DNS must not be routed off the link. */
const MULTICAST_TTL = 255;
const GOODBYE_FLUSH_MS = 250;

function toIpv4(address: string): number | null {
  // A udp4 socket can hand back the mapped form on some platforms.
  const plain = address.replace(/^::ffff:/i, "").split("%")[0];
  const parts = plain.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = out * 256 + octet;
  }
  return out >>> 0;
}

/** RFC 6762 §5.5: a responder answers link-local queries only; answering
 * anyone makes it an off-link discovery service and a UDP reflector (§11).
 * Judged by the interface netmasks; loopback passes. */
export function isOnLink(from: string, interfaces = networkInterfaces()): boolean {
  const source = toIpv4(from);
  if (source === null) return false;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      const address = toIpv4(entry.address);
      const mask = toIpv4(entry.netmask);
      if (address === null || mask === null) continue;
      if ((((source ^ address) & mask) >>> 0) === 0) return true;
    }
  }
  return false;
}

export const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
/** Top bit of a record's class: "this replaces whatever you cached." */
const FLUSH = 0x8000;
/** Top bit of a question's class: "answer me directly, not to the group." */
const QU = 0x8000;
/** The meta-query browsers use to enumerate service types on a network. */
export const SERVICE_ENUMERATION = "_services._dns-sd._udp.local";


export interface Question {
  name: string;
  type: number;
  /** the QU bit — the asker wants a unicast reply */
  unicast: boolean;
}

export interface DnsMessage {
  id: number;
  response: boolean;
  questions: Question[];
}

export type ResourceRecord =
  | { name: string; type: 1; data: string }
  | { name: string; type: 12; data: string }
  | { name: string; type: 16; data: string[] }
  | { name: string; type: 33; data: { port: number; target: string } };

export function encodeName(name: string): Buffer {
  const chunks: Buffer[] = [];
  for (const label of name.split(".").filter(Boolean)) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error(`label longer than 63 bytes: ${label}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Follows compression pointers; the returned offset is just past the name as
 * written here, not where a followed pointer ended. */
function decodeName(buf: Buffer, start: number): { name: string; offset: number } {
  const labels: string[] = [];
  let pos = start;
  let end = start;
  let jumped = false;
  let hops = 0;

  for (;;) {
    if (pos >= buf.length) throw new Error("truncated name");
    const length = buf[pos];
    if (length === 0) {
      if (!jumped) end = pos + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("truncated pointer");
      const target = ((length & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      // a packet is free to point at itself; we are not free to follow it
      if (++hops > 16) throw new Error("compression pointer loop");
      pos = target;
      continue;
    }
    const from = pos + 1;
    if (from + length > buf.length) throw new Error("truncated label");
    labels.push(buf.toString("utf8", from, from + length));
    pos = from + length;
    if (!jumped) end = pos;
  }
  return { name: labels.join("."), offset: end };
}

/** Every byte here is unauthenticated, so a malformed packet must be a `null`,
 * never a throw into the socket handler. */
export function decodeMessage(buf: Buffer): DnsMessage | null {
  try {
    if (buf.length < 12) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const questionCount = buf.readUInt16BE(4);
    const questions: Question[] = [];
    let offset = 12;
    for (let i = 0; i < questionCount; i++) {
      const decoded = decodeName(buf, offset);
      offset = decoded.offset;
      if (offset + 4 > buf.length) return null;
      const type = buf.readUInt16BE(offset);
      const klass = buf.readUInt16BE(offset + 2);
      offset += 4;
      questions.push({ name: decoded.name, type, unicast: (klass & QU) !== 0 });
    }
    return { id, response: (flags & 0x8000) !== 0, questions };
  } catch {
    return null;
  }
}

/** The cache-flush bit (RFC 6762 §10.2) is forbidden on shared records (the
 * service PTR and the enumeration PTR, which other machines answer too) and
 * on legacy-unicast replies (§6.7). The rrtype test holds only for the RRsets
 * serviceRecords builds. Unique names here are not probed (§8.1): ownership
 * rests on the hashed host name. */
function mayFlush(record: ResourceRecord, legacy: boolean): boolean {
  return !legacy && record.type !== TYPE.PTR;
}

/** `ttlOverride` 0 sends a goodbye: "forget what I told you". */
function encodeRecord(record: ResourceRecord, ttlOverride: number | undefined, flush: boolean): Buffer {
  let rdata: Buffer;
  let ttl: number;
  switch (record.type) {
    case TYPE.A: {
      const octets = record.data.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new Error(`not an IPv4 address: ${record.data}`);
      }
      rdata = Buffer.from(octets);
      ttl = TTL_HOST;
      break;
    }
    case TYPE.PTR:
      rdata = encodeName(record.data);
      ttl = TTL_SERVICE;
      break;
    case TYPE.TXT: {
      const entries = record.data.map((entry) => {
        const bytes = Buffer.from(entry, "utf8");
        if (bytes.length > 255) throw new Error(`TXT entry longer than 255 bytes: ${entry}`);
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
      });
      // an empty TXT record is one zero-length string, never zero bytes
      rdata = entries.length ? Buffer.concat(entries) : Buffer.from([0]);
      ttl = TTL_SERVICE;
      break;
    }
    case TYPE.SRV: {
      const header = Buffer.alloc(6);
      header.writeUInt16BE(0, 0); // priority
      header.writeUInt16BE(0, 2); // weight
      header.writeUInt16BE(record.data.port, 4);
      rdata = Buffer.concat([header, encodeName(record.data.target)]);
      ttl = TTL_HOST;
      break;
    }
  }

  const name = encodeName(record.name);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(record.type, 0);
  fixed.writeUInt16BE(flush ? CLASS_IN | FLUSH : CLASS_IN, 2);
  fixed.writeUInt32BE(ttlOverride ?? ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, fixed, rdata]);
}

export function encodeResponse(
  answers: ResourceRecord[],
  additionals: ResourceRecord[] = [],
  opts: { id?: number; ttl?: number; questions?: Question[]; legacy?: boolean } = {},
): Buffer {
  const questions = opts.questions ?? [];
  const legacy = opts.legacy ?? false;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id ?? 0, 0);
  header.writeUInt16BE(0x8400, 2); // QR=1 (response), AA=1 (authoritative)
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);

  const questionBytes = questions.map((question) => {
    const suffix = Buffer.alloc(4);
    suffix.writeUInt16BE(question.type, 0);
    suffix.writeUInt16BE(CLASS_IN, 2);
    return Buffer.concat([encodeName(question.name), suffix]);
  });

  return Buffer.concat([
    header,
    ...questionBytes,
    ...answers.map((record) => encodeRecord(record, opts.ttl, mayFlush(record, legacy))),
    ...additionals.map((record) => encodeRecord(record, opts.ttl, mayFlush(record, legacy))),
  ]);
}


export interface ServiceInfo {
  /** what a picker on the phone shows */
  name: string;
  /** e.g. "_openmausbot._tcp" */
  type: string;
  port: number;
  /** the name our A records claim, e.g. "openmausbot-1a2b3c4d.local" */
  host: string;
  addresses: string[];
  /** DNS-SD key=value pairs */
  txt: string[];
}

const recordKey = (record: ResourceRecord) =>
  `${record.name.toLowerCase()}|${record.type}|${JSON.stringify(record.data)}`;

function dedupe(records: ResourceRecord[], exclude: ResourceRecord[] = []): ResourceRecord[] {
  const seen = new Set(exclude.map(recordKey));
  const out: ResourceRecord[] = [];
  for (const record of records) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

export function serviceRecords(service: ServiceInfo) {
  const serviceName = `${service.type}.local`;
  const instance = `${service.name}.${serviceName}`;
  return {
    serviceName,
    instance,
    ptr: { name: serviceName, type: TYPE.PTR, data: instance } as ResourceRecord,
    srv: {
      name: instance,
      type: TYPE.SRV,
      data: { port: service.port, target: service.host },
    } as ResourceRecord,
    txt: { name: instance, type: TYPE.TXT, data: service.txt } as ResourceRecord,
    addresses: service.addresses.map(
      (address) => ({ name: service.host, type: TYPE.A, data: address }) as ResourceRecord,
    ),
  };
}

export function announcement(service: ServiceInfo): ResourceRecord[] {
  const { ptr, srv, txt, addresses } = serviceRecords(service);
  return [ptr, srv, txt, ...addresses];
}

/** A PTR question is answered with SRV, TXT and A in the additional section
 * (RFC 6763 §12), so browsing resolves in one round trip. */
export function answersFor(
  message: DnsMessage,
  service: ServiceInfo,
): { answers: ResourceRecord[]; additionals: ResourceRecord[] } {
  if (message.response) return { answers: [], additionals: [] };
  const { serviceName, instance, ptr, srv, txt, addresses } = serviceRecords(service);
  const answers: ResourceRecord[] = [];
  const additionals: ResourceRecord[] = [];

  for (const question of message.questions) {
    const name = question.name.toLowerCase();
    const asks = (type: number) => question.type === type || question.type === TYPE.ANY;

    if (name === SERVICE_ENUMERATION && asks(TYPE.PTR)) {
      answers.push({ name: SERVICE_ENUMERATION, type: TYPE.PTR, data: serviceName });
    } else if (name === serviceName.toLowerCase() && asks(TYPE.PTR)) {
      answers.push(ptr);
      additionals.push(srv, txt, ...addresses);
    } else if (name === instance.toLowerCase()) {
      if (asks(TYPE.SRV)) {
        answers.push(srv);
        additionals.push(...addresses);
      }
      if (asks(TYPE.TXT)) answers.push(txt);
    } else if (name === service.host.toLowerCase() && asks(TYPE.A)) {
      answers.push(...addresses);
    }
  }

  const deduped = dedupe(answers);
  return { answers: deduped, additionals: dedupe(additionals, deduped) };
}


/** No dots, no control characters, at most 63 bytes of UTF-8. */
export function dnsLabel(text: string, fallback = "OpenMausBot"): string {
  let label = text
    // oxlint-disable-next-line no-control-regex -- control characters are not valid in a DNS label
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\./g, " ")
    .trim();
  while (Buffer.byteLength(label, "utf8") > 63) label = label.slice(0, -1).trimEnd();
  return label || fallback;
}

/** DNS-SD limits are bytes (63 per label, 255 per TXT entry), not UTF-16 code
 * units; iterating keeps whole code points. */
export function clampBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let out = "";
  let size = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (size + width > limit) break;
    out += character;
    size += width;
  }
  return out;
}

/** Not `<hostname>.local`: on macOS mDNSResponder owns and defends that name. */
export function defaultHostName(machine = hostname()): string {
  const digest = createHash("sha256").update(machine).digest("hex").slice(0, 8);
  return `openmausbot-${digest}.local`;
}

/** macOS point-to-point tunnels: utun (every VPN, Tailscale, tun2socks),
 * ipsec, ppp. Multicast cannot cross them, and on macOS 27 closing a socket
 * that held memberships on a utun that came or went hung the kernel and
 * panicked the Mac. Typed-address and tailnet pairing do not use mDNS. */
const MAC_TUNNEL_INTERFACE = /^(utun|ipsec|ppp)\d*$/i;

export function advertisableAddresses(interfaces = networkInterfaces(), platform = process.platform): string[] {
  return lanInterfaces(interfaces)
    .filter((entry) => platform !== "darwin" || !MAC_TUNNEL_INTERFACE.test(entry.name))
    .map((entry) => entry.address);
}


export interface ResponderSocket {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (message: Buffer, remote: { address: string; port: number }) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  bind(port: number, callback?: () => void): void;
  setMulticastTTL(ttl: number): void;
  addMembership(group: string, membershipInterface?: string): void;
  setMulticastInterface(multicastInterface: string): void;
  send(packet: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(callback?: () => void): void;
  address(): { port: number };
}

export interface ResponderOptions {
  port?: number;
  multicast?: boolean;
  socketFactory?: () => ResponderSocket;
  platform?: NodeJS.Platform;
}

export class MdnsResponder {
  private socket: ResponderSocket | null = null;
  private service: ServiceInfo | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private sendQueue: Promise<void> = Promise.resolve();
  /** Bumped by every stop(), so a bind still in flight knows it was cancelled. */
  private stops = 0;
  private readonly port: number;
  private readonly multicast: boolean;
  private readonly socketFactory: () => ResponderSocket;
  private readonly platform: NodeJS.Platform;

  constructor(options: ResponderOptions = {}) {
    this.port = options.port ?? MDNS_PORT;
    this.multicast = options.multicast ?? true;
    this.socketFactory = options.socketFactory ?? (() => createSocket({ type: "udp4", reuseAddr: true }));
    this.platform = options.platform ?? process.platform;
  }

  get advertising(): boolean {
    return this.socket !== null;
  }

  address(): number | null {
    try {
      return this.socket?.address().port ?? null;
    } catch {
      return null;
    }
  }

  /** Resolves false when mDNS could not start, which is never fatal: pairing
   * by typed address still works. */
  async advertise(service: ServiceInfo): Promise<boolean> {
    // stop() counts itself before its goodbye wait, so a shutdown during that wait is still seen below.
    const stopping = this.stop();
    const stops = this.stops;
    await stopping;
    if (!service.addresses.length) return false;

    const socket = this.socketFactory();
    // An unhandled socket 'error' event is an uncaught exception.
    socket.on("error", () => void this.stop());
    socket.on("message", (buf, remote) => this.handle(buf, remote.address, remote.port));

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(this.port, () => resolve());
      });
    } catch {
      try {
        socket.close();
      } catch {
      }
      return false;
    }
    // stop() ran while the bind was pending: it found no socket to close, so close this one.
    if (stops !== this.stops) {
      try {
        socket.close();
      } catch {
      }
      return false;
    }

    if (this.multicast) {
      try {
        socket.setMulticastTTL(MULTICAST_TTL);
      } catch {
      }
      // Join per interface: the default route is not necessarily the phone's network.
      let joined = false;
      for (const address of service.addresses) {
        try {
          socket.addMembership(MDNS_ADDRESS, address);
          joined = true;
        } catch {
        }
      }
      // On a Mac the default route may be a VPN tunnel (see MAC_TUNNEL_INTERFACE).
      if (!joined && this.platform !== "darwin") {
        try {
          socket.addMembership(MDNS_ADDRESS);
        } catch {
        }
      }
    }

    this.socket = socket;
    this.service = service;
    // RFC 6762 §8.3: announce more than once, spaced out.
    for (const delay of [0, 1000, 3000]) {
      const timer = setTimeout(() => this.announce(), delay);
      timer.unref?.();
      this.timers.push(timer);
    }
    return true;
  }

  /** Sends a goodbye so the records don't sit in caches for 75 minutes
   * (RFC 6762 §10.1). */
  async stop(): Promise<void> {
    this.stops += 1;
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    const socket = this.socket;
    const service = this.service;
    this.socket = null;
    this.service = null;
    if (!socket) return;
    if (service) {
      // `close` does not flush a queued send, so wait for the goodbye to
      // leave; bounded so shutdown cannot hang on a network that is gone.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, GOODBYE_FLUSH_MS);
        timer.unref?.();
        try {
          this.send(socket, encodeResponse(announcement(service), [], { ttl: 0 }), service.addresses, () => {
            clearTimeout(timer);
            finish();
          });
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    }
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private announce() {
    if (!this.socket || !this.service) return;
    try {
      this.send(this.socket, encodeResponse(announcement(this.service)), this.service.addresses);
    } catch {
    }
  }

  private handle(buf: Buffer, from: string, fromPort: number) {
    if (!this.socket || !this.service) return;
    // RFC 6762 §5.5 and §11: answer the local link only, or this socket is a
    // reflector for spoofed source addresses.
    if (!isOnLink(from)) return;
    const message = decodeMessage(buf);
    if (!message || message.response || !message.questions.length) return;
    const { answers, additionals } = answersFor(message, this.service);
    if (!answers.length) return;

    // RFC 6762 §6.7: a query from a port other than 5353 is a legacy
    // resolver; reply to that port, echoing the id and the question.
    const legacy = fromPort !== MDNS_PORT;
    const unicast = legacy || message.questions.some((question) => question.unicast);
    const packet = encodeResponse(
      answers,
      additionals,
      legacy ? { id: message.id, questions: message.questions, legacy: true } : {},
    );
    try {
      // The kernel routes unicast replies; only group sends are pinned.
      if (unicast) this.socket.send(packet, fromPort, from);
      else this.send(this.socket, packet, this.service.addresses);
    } catch {
    }
  }

  /** Always to port 5353, once per advertised interface: a bare group send
   * leaves on whichever interface the kernel routes 224.0.0.251 to, which
   * with a VPN or VM bridge up may not be the phone's network. Serialized,
   * because `setMulticastInterface` redirects every subsequent send while
   * `send` completes a tick later. */
  private send(
    socket: ResponderSocket,
    packet: Buffer,
    addresses: string[],
    done?: (error: Error | null) => void,
  ) {
    if (!this.multicast) {
      done?.(null);
      return;
    }
    this.sendQueue = this.sendQueue.then(async () => {
      for (const address of addresses) {
        await new Promise<void>((resolve) => {
          try {
            socket.setMulticastInterface(address);
          } catch {
            // The interface vanished between enumeration and send; skip it.
            resolve();
            return;
          }
          try {
            socket.send(packet, MDNS_PORT, MDNS_ADDRESS, () => resolve());
          } catch {
            resolve();
          }
        });
      }
      done?.(null);
    });
  }
}
