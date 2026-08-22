// mDNS responder contract. The wire format is the part with no room for
// "close enough" — a browser either parses the packet or the service is
// invisible — so it is tested byte by byte, against packets built by hand
// rather than by the encoder under test.
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfoIPv4 } from "node:os";
import { describe, expect, it } from "vitest";

import { lanAddresses, tailscaleAddress } from "../src/listener.ts";
import {
  advertisableAddresses,
  announcement,
  answersFor,
  clampBytes,
  decodeMessage,
  defaultHostName,
  dnsLabel,
  encodeName,
  encodeResponse,
  isOnLink,
  MdnsResponder,
  SERVICE_ENUMERATION,
  serviceRecords,
  TYPE,
  type ServiceInfo,
} from "../src/mdns.ts";

const service: ServiceInfo = {
  name: "Milind's computer",
  type: "_openmausbot._tcp",
  port: 8800,
  host: "openmausbot-1a2b3c4d.local",
  addresses: ["192.168.1.42"],
  txt: ["v=1", "name=Milind's computer"],
};

const INSTANCE = "Milind's computer._openmausbot._tcp.local";
const SERVICE_NAME = "_openmausbot._tcp.local";

/** A query packet, built by hand so the decoder is tested against the
 * format rather than against our own encoder. */
function query(name: string, type: number, opts: { id?: number; unicast?: boolean } = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id ?? 0, 0);
  header.writeUInt16BE(0, 2); // QR=0, a question
  header.writeUInt16BE(1, 4);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt16BE(type, 0);
  suffix.writeUInt16BE(opts.unicast ? 0x8001 : 1, 2);
  return Buffer.concat([header, encodeName(name), suffix]);
}

/** Read the records out of a response packet — again by hand. */
function parseResponse(buf: Buffer) {
  const questionCount = buf.readUInt16BE(4);
  const answerCount = buf.readUInt16BE(6);
  const additionalCount = buf.readUInt16BE(10);
  let offset = 12;

  const readName = (): string => {
    const labels: string[] = [];
    for (;;) {
      const length = buf[offset];
      if (length === 0) {
        offset += 1;
        break;
      }
      labels.push(buf.toString("utf8", offset + 1, offset + 1 + length));
      offset += 1 + length;
    }
    return labels.join(".");
  };

  for (let i = 0; i < questionCount; i++) {
    readName();
    offset += 4;
  }

  const records: Array<{ name: string; type: number; klass: number; ttl: number; rdata: Buffer }> = [];
  for (let i = 0; i < answerCount + additionalCount; i++) {
    const name = readName();
    const type = buf.readUInt16BE(offset);
    const klass = buf.readUInt16BE(offset + 2);
    const ttl = buf.readUInt32BE(offset + 4);
    const length = buf.readUInt16BE(offset + 8);
    const rdata = buf.subarray(offset + 10, offset + 10 + length);
    offset += 10 + length;
    records.push({ name, type, klass, ttl, rdata });
  }
  return { id: buf.readUInt16BE(0), flags: buf.readUInt16BE(2), questionCount, answerCount, records };
}

describe("wire format", () => {
  it("encodes names as length-prefixed labels", () => {
    expect(encodeName("a.bc")).toEqual(Buffer.from([1, 0x61, 2, 0x62, 0x63, 0]));
    expect(encodeName("")).toEqual(Buffer.from([0]));
    expect(() => encodeName("x".repeat(64))).toThrow(/63 bytes/);
  });

  it("decodes a question, QU bit included", () => {
    const decoded = decodeMessage(query(SERVICE_NAME, TYPE.PTR, { id: 7 }));
    expect(decoded).toMatchObject({ id: 7, response: false });
    expect(decoded!.questions).toEqual([{ name: SERVICE_NAME, type: TYPE.PTR, unicast: false }]);

    const direct = decodeMessage(query(SERVICE_NAME, TYPE.PTR, { unicast: true }));
    expect(direct!.questions[0].unicast).toBe(true);
  });

  it("follows a compression pointer without following it forever", () => {
    // question name is a pointer to offset 12, where the real name sits
    const name = encodeName(SERVICE_NAME);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4);
    const suffix = Buffer.alloc(4);
    suffix.writeUInt16BE(TYPE.PTR, 0);
    suffix.writeUInt16BE(1, 2);
    // layout: header(12) | pointer(2) | type+class(4) | the name it points at
    const pointer = Buffer.from([0xc0, 12 + 2 + 4]);
    const packet = Buffer.concat([header, pointer, suffix, name]);
    expect(decodeMessage(packet)!.questions[0].name).toBe(SERVICE_NAME);

    // a pointer to itself must not hang the socket handler
    const loop = Buffer.concat([header, Buffer.from([0xc0, 12]), suffix]);
    expect(decodeMessage(loop)).toBeNull();
  });

  it("returns null for anything it cannot read, rather than throwing", () => {
    // these arrive unauthenticated from the local network
    expect(decodeMessage(Buffer.alloc(0))).toBeNull();
    expect(decodeMessage(Buffer.alloc(5))).toBeNull();
    expect(decodeMessage(Buffer.from([0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]))).toBeNull();
    // a label claiming more bytes than the packet holds
    const oneQuestion = Buffer.alloc(12);
    oneQuestion.writeUInt16BE(1, 4);
    expect(decodeMessage(Buffer.concat([oneQuestion, Buffer.from([40, 0x61])]))).toBeNull();
    // a header promising questions that were never written
    const liar = Buffer.alloc(12);
    liar.writeUInt16BE(9, 4);
    expect(decodeMessage(liar)).toBeNull();
  });

  it("encodes each record type the way a browser expects to read it", () => {
    const { ptr, srv, txt, addresses } = serviceRecords(service);
    const parsed = parseResponse(encodeResponse([ptr, srv, txt, ...addresses]));

    expect(parsed.flags).toBe(0x8400); // response, authoritative
    expect(parsed.answerCount).toBe(4);

    const [ptrRec, srvRec, txtRec, aRec] = parsed.records;
    // every record sets the cache-flush bit and class IN
    for (const record of parsed.records) expect(record.klass).toBe(0x8001);

    expect(ptrRec).toMatchObject({ name: SERVICE_NAME, type: TYPE.PTR, ttl: 4500 });

    expect(srvRec).toMatchObject({ name: INSTANCE, type: TYPE.SRV, ttl: 120 });
    expect(srvRec.rdata.readUInt16BE(0)).toBe(0); // priority
    expect(srvRec.rdata.readUInt16BE(2)).toBe(0); // weight
    expect(srvRec.rdata.readUInt16BE(4)).toBe(8800);

    expect(txtRec.type).toBe(TYPE.TXT);
    expect(txtRec.rdata[0]).toBe(3); // "v=1" is length-prefixed
    expect(txtRec.rdata.toString("utf8", 1, 4)).toBe("v=1");

    expect(aRec).toMatchObject({ name: service.host, type: TYPE.A, ttl: 120 });
    expect([...aRec.rdata]).toEqual([192, 168, 1, 42]);
  });

  it("writes a goodbye as the same records with a zero TTL", () => {
    const parsed = parseResponse(encodeResponse(announcement(service), [], { ttl: 0 }));
    expect(parsed.records).toHaveLength(4);
    for (const record of parsed.records) expect(record.ttl).toBe(0);
  });

  it("encodes an empty TXT as one empty string, not zero bytes", () => {
    const [record] = parseResponse(encodeResponse([{ name: INSTANCE, type: TYPE.TXT, data: [] }])).records;
    expect([...record.rdata]).toEqual([0]);
  });
});

describe("answersFor", () => {
  const ask = (name: string, type: number) => answersFor(decodeMessage(query(name, type))!, service);

  it("answers a browse with the resolution attached", () => {
    const { answers, additionals } = ask(SERVICE_NAME, TYPE.PTR);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ type: TYPE.PTR, data: INSTANCE });
    // SRV + TXT + A ride along so browsing resolves in one round trip
    expect(additionals.map((r) => r.type).sort()).toEqual([TYPE.A, TYPE.TXT, TYPE.SRV].sort());
  });

  it("answers a resolve, and an address lookup", () => {
    const srv = ask(INSTANCE, TYPE.SRV);
    expect(srv.answers[0]).toMatchObject({ type: TYPE.SRV, data: { port: 8800, target: service.host } });
    expect(srv.additionals[0]).toMatchObject({ type: TYPE.A });

    expect(ask(INSTANCE, TYPE.TXT).answers[0]).toMatchObject({ type: TYPE.TXT });
    expect(ask(service.host, TYPE.A).answers[0]).toMatchObject({ type: TYPE.A, data: "192.168.1.42" });
  });

  it("answers ANY with everything about that name, and never twice", () => {
    const { answers, additionals } = ask(INSTANCE, TYPE.ANY);
    expect(answers.map((r) => r.type).sort()).toEqual([TYPE.TXT, TYPE.SRV].sort());
    // the A record is an additional, so it must not also be an answer
    expect(additionals.map((r) => r.type)).toEqual([TYPE.A]);
  });

  it("takes part in service-type enumeration", () => {
    const { answers } = ask(SERVICE_ENUMERATION, TYPE.PTR);
    expect(answers[0]).toMatchObject({ name: SERVICE_ENUMERATION, data: SERVICE_NAME });
  });

  it("matches names case-insensitively, as DNS does", () => {
    expect(ask(SERVICE_NAME.toUpperCase(), TYPE.PTR).answers).toHaveLength(1);
  });

  it("stays silent about anything that is not ours", () => {
    expect(ask("_ssh._tcp.local", TYPE.PTR).answers).toEqual([]);
    expect(ask("someone-else.local", TYPE.A).answers).toEqual([]);
    // right name, wrong type
    expect(ask(service.host, TYPE.SRV).answers).toEqual([]);
    // and we answer questions, not other people's answers
    const response = decodeMessage(encodeResponse(announcement(service)))!;
    expect(answersFor({ ...response, response: true, questions: [] }, service).answers).toEqual([]);
  });
});

describe("naming", () => {
  it("keeps an instance name to a single valid label", () => {
    // a dot would silently split the name into two labels
    expect(dnsLabel("Dr. Smith's computer")).toBe("Dr  Smith's computer");
    expect(dnsLabel("x".repeat(200)).length).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(dnsLabel("é".repeat(60)), "utf8")).toBeLessThanOrEqual(63);
    expect(dnsLabel("")).toBe("OpenMausBot");
    expect(dnsLabel("   ")).toBe("OpenMausBot");
  });

  it("claims a host name the system responder will not fight us for", () => {
    const name = defaultHostName("Milinds-MacBook-Pro");
    expect(name).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
    // stable across restarts, distinct per machine
    expect(defaultHostName("Milinds-MacBook-Pro")).toBe(name);
    expect(defaultHostName("another-machine")).not.toBe(name);
    expect(name).not.toContain("Milinds-MacBook-Pro");
  });

  it("publishes only routable IPv4 addresses", () => {
    for (const address of advertisableAddresses()) {
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(address.startsWith("127.")).toBe(false);
      expect(address.startsWith("169.254.")).toBe(false);
    }
  });
});

// The socket loop, over unicast on an ephemeral port: no multicast group is
// needed to prove that a query in becomes a correct answer out, and CI
// containers rarely route multicast at all.
describe("MdnsResponder", () => {
  const askResponder = (port: number, packet: Buffer) =>
    new Promise<Buffer>((resolve, reject) => {
      const socket = createSocket("udp4");
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("no response from the responder"));
      }, 5_000);
      timer.unref?.();
      socket.on("message", (buf) => {
        clearTimeout(timer);
        socket.close();
        resolve(buf);
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.bind(0, "127.0.0.1", () => socket.send(packet, port, "127.0.0.1"));
    });

  it("answers a real query on a real socket", async () => {
    const responder = new MdnsResponder({ port: 0, multicast: false });
    expect(await responder.advertise(service)).toBe(true);
    try {
      const port = responder.address()!;
      const parsed = parseResponse(await askResponder(port, query(SERVICE_NAME, TYPE.PTR, { id: 42 })));

      // a query from an ephemeral port is a legacy resolver: it gets its
      // own id and question echoed back (RFC 6762 §6.7)
      expect(parsed.id).toBe(42);
      expect(parsed.questionCount).toBe(1);
      expect(parsed.answerCount).toBe(1);
      expect(parsed.records[0]).toMatchObject({ name: SERVICE_NAME, type: TYPE.PTR });
      expect(parsed.records.some((r) => r.type === TYPE.SRV)).toBe(true);
    } finally {
      await responder.stop();
    }
  });

  it("says nothing at all about a service that is not ours", async () => {
    const responder = new MdnsResponder({ port: 0, multicast: false });
    await responder.advertise(service);
    try {
      await expect(askResponder(responder.address()!, query("_ssh._tcp.local", TYPE.PTR))).rejects.toThrow(
        /no response/,
      );
    } finally {
      await responder.stop();
    }
  }, 15_000);

  it("survives garbage on the socket", async () => {
    const responder = new MdnsResponder({ port: 0, multicast: false });
    await responder.advertise(service);
    const port = responder.address()!;
    try {
      const noise = createSocket("udp4");
      // An unhandled 'error' on a dgram socket is an uncaught exception, and
      // it would surface as this file failing somewhere else entirely.
      noise.on("error", () => {});
      await new Promise<void>((resolve) => noise.bind(0, "127.0.0.1", resolve));
      // Await each send. `send` is asynchronous, so closing on the next line
      // can beat the datagrams out of the socket — close() on a socket with
      // datagrams still queued drops them, the responder then never sees the
      // garbage, and this passes without exercising the path it is named
      // after.
      for (const junk of [Buffer.alloc(0), Buffer.from("hello"), Buffer.alloc(600, 0xff)]) {
        await new Promise<void>((resolve) => noise.send(junk, port, "127.0.0.1", () => resolve()));
      }
      await new Promise<void>((resolve) => noise.close(() => resolve()));

      // still answering afterwards is the assertion that matters
      const parsed = parseResponse(await askResponder(port, query(SERVICE_NAME, TYPE.PTR)));
      expect(parsed.answerCount).toBe(1);
    } finally {
      await responder.stop();
    }
  });

  it("refuses to advertise with no address to publish, and stops cleanly", async () => {
    const responder = new MdnsResponder({ port: 0, multicast: false });
    expect(await responder.advertise({ ...service, addresses: [] })).toBe(false);
    expect(responder.advertising).toBe(false);
    // stopping something that never started is a no-op, not a crash
    await responder.stop();

    expect(await responder.advertise(service)).toBe(true);
    expect(responder.advertising).toBe(true);
    await responder.stop();
    expect(responder.advertising).toBe(false);
    expect(responder.address()).toBeNull();
  });
});

// The outbound half of multicast. Joining the group per interface only fixes
// what we *hear*; every group send must also be pinned per interface, or the
// kernel routes 224.0.0.251 out of exactly one interface of its choosing —
// with a VPN or VM bridge up, a network the phone is not on. None of this
// reaches the wire in CI, so a recording socket is where it gets asserted.
describe("multicast interface pinning", () => {
  /** A socket that logs what the responder does to it. Satisfies
   * `ResponderSocket` structurally — no casting required. */
  class FakeSocket extends EventEmitter {
    readonly ops: Array<{ op: "pin" | "send"; address: string; port?: number }> = [];
    bind(_port: number, callback?: () => void) {
      callback?.();
    }
    setMulticastTTL(_ttl: number) {}
    addMembership(_group: string, _membershipInterface?: string) {}
    setMulticastInterface(multicastInterface: string) {
      this.ops.push({ op: "pin", address: multicastInterface });
    }
    send(_packet: Buffer, port: number, address: string, callback?: (error: Error | null) => void) {
      this.ops.push({ op: "send", address, port });
      callback?.(null);
    }
    close(callback?: () => void) {
      callback?.();
    }
    address() {
      return { port: 5353 };
    }
  }

  const homes = ["192.168.1.42", "10.0.0.7"];
  /** One announcement burst, as the ops log should show it: pin, send, pin,
   * send — the pin *before* each send, per advertised interface, because
   * `setMulticastInterface` redirects the sends that come after it. */
  const pinnedBurst = homes.flatMap((address) => [
    { op: "pin", address },
    { op: "send", address: "224.0.0.251", port: 5353 },
  ]);

  // The fake's callbacks fire synchronously, so the first announcement (the
  // 0 ms timer) has fully drained once one later macrotask runs.
  const drained = () => new Promise((resolve) => setTimeout(resolve, 25));

  it("pins every announcement and goodbye to each advertised interface, in order", async () => {
    const socket = new FakeSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    expect(await responder.advertise({ ...service, addresses: homes })).toBe(true);
    await drained();
    expect(socket.ops).toEqual(pinnedBurst);

    // the goodbye withdraws the records everywhere they were announced
    socket.ops.length = 0;
    await responder.stop();
    expect(socket.ops).toEqual(pinnedBurst);
  });

  it("pins a multicast answer the same way", async () => {
    const socket = new FakeSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    await responder.advertise({ ...service, addresses: homes });
    await drained();
    socket.ops.length = 0;
    try {
      // port 5353, no QU bit: the answer goes back to the group
      socket.emit("message", query(SERVICE_NAME, TYPE.PTR), { address: "127.0.0.1", port: 5353 });
      await drained();
      expect(socket.ops).toEqual(pinnedBurst);
    } finally {
      await responder.stop();
    }
  });

  it("sends a unicast answer as-is: routed to the asker, never pinned", async () => {
    const socket = new FakeSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    await responder.advertise({ ...service, addresses: homes });
    await drained();
    socket.ops.length = 0;
    try {
      // an ephemeral source port marks a legacy resolver (RFC 6762 §6.7)
      socket.emit("message", query(SERVICE_NAME, TYPE.PTR, { id: 9 }), { address: "127.0.0.1", port: 40404 });
      await drained();
      expect(socket.ops).toEqual([{ op: "send", address: "127.0.0.1", port: 40404 }]);
    } finally {
      await responder.stop();
    }
  });

  it("skips an interface that vanished between enumeration and send", async () => {
    class VanishingSocket extends FakeSocket {
      setMulticastInterface(multicastInterface: string) {
        // what a dropped VPN or pulled cable looks like from here
        if (multicastInterface === "10.0.0.7") throw new Error("EADDRNOTAVAIL");
        super.setMulticastInterface(multicastInterface);
      }
    }
    const socket = new VanishingSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    await responder.advertise({ ...service, addresses: homes });
    await drained();
    try {
      // the surviving interface still gets its packet, and nothing crashed
      expect(socket.ops).toEqual([
        { op: "pin", address: "192.168.1.42" },
        { op: "send", address: "224.0.0.251", port: 5353 },
      ]);
      expect(responder.advertising).toBe(true);
    } finally {
      await responder.stop();
    }
  });
});

// Which address leads matters: callers print the first non-tailnet entry into
// the pairing QR, and `networkInterfaces()` promises nothing about order — a
// Mac with a VPN or a VM can enumerate utun or bridge100 first, and a QR
// carrying one of those addresses points the phone at a network it is not on.
describe("lanAddresses", () => {
  const ipv4 = (address: string, internal = false): NetworkInterfaceInfoIPv4 => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  });

  it("ranks en0 first however the interfaces enumerate", () => {
    // deliberately listed worst-first: insertion order must not win
    const addresses = lanAddresses({
      utun4: [ipv4("100.102.178.88")],
      bridge100: [ipv4("192.168.64.1")],
      vmnet1: [ipv4("192.168.105.1")],
      en0: [ipv4("192.168.1.42")],
    });
    expect(addresses[0]).toBe("192.168.1.42");
    // the virtual interfaces are kept — the tailnet address is dialable
    // from off-network — but only after everything real
    expect(addresses).toEqual(["192.168.1.42", "100.102.178.88", "192.168.64.1", "192.168.105.1"]);
  });

  it("slots an unrecognized real interface between en0 and the tunnels", () => {
    expect(
      lanAddresses({
        utun0: [ipv4("100.102.178.88")],
        ap1: [ipv4("172.20.10.1")],
        en1: [ipv4("192.168.1.42")],
      }),
    ).toEqual(["192.168.1.42", "172.20.10.1", "100.102.178.88"]);
  });

  it("still drops loopback and link-local, wherever they rank", () => {
    expect(
      lanAddresses({
        lo0: [ipv4("127.0.0.1", true)],
        en0: [ipv4("169.254.7.7")],
      }),
    ).toEqual([]);
  });
});

// Tailscale hands out 100.64.0.0/10 (RFC 6598 shared address space), which
// is what makes a tailnet address distinguishable from a LAN one — and
// worth distinguishing, because it is the address that still works when the
// phone is on a different network entirely.
describe("tailscaleAddress", () => {
  it("picks the CGNAT address out of a mixed list", () => {
    expect(tailscaleAddress(["192.168.1.42", "100.102.178.88"])).toBe("100.102.178.88");
    expect(tailscaleAddress(["100.64.0.1"])).toBe("100.64.0.1");
    expect(tailscaleAddress(["100.127.255.254"])).toBe("100.127.255.254");
  });

  it("does not mistake a neighbouring 100.x for a tailnet", () => {
    // 100.0.0.0/10 and 100.128.0.0/9 are ordinary public space
    expect(tailscaleAddress(["100.63.255.255"])).toBeNull();
    expect(tailscaleAddress(["100.128.0.1"])).toBeNull();
    expect(tailscaleAddress(["10.0.0.5", "192.168.1.1", "172.16.0.1"])).toBeNull();
    expect(tailscaleAddress([])).toBeNull();
  });
});

// RFC 6762 §5.5: a multicast DNS responder answers link-local queries only.
// A responder that replies to anything able to route to it is an off-link
// discovery service for whoever asks — it names this computer, its addresses
// and its owner — and a UDP reflector besides, since the reply goes wherever
// the source address claims and that claim is free to make.
describe("isOnLink", () => {
  // SAFETY: the literal below carries exactly the four fields `isOnLink`
  // reads — family, address, netmask, internal — for each interface; the
  // assertion stands in for the rest of NetworkInterfaceInfo (cidr, mac,
  // scopeid), which nothing on this path touches.
  const interfaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
    en0: [{ family: "IPv4", address: "192.168.1.42", netmask: "255.255.255.0", internal: false }],
    ts0: [{ family: "IPv4", address: "100.102.178.88", netmask: "255.192.0.0", internal: false }],
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  it("accepts a source on a directly attached subnet", () => {
    expect(isOnLink("192.168.1.7", interfaces)).toBe(true);
    expect(isOnLink("192.168.1.42", interfaces)).toBe(true);
    expect(isOnLink("100.102.178.1", interfaces)).toBe(true);
    // the test rig, and the desktop app, both speak to this over loopback
    expect(isOnLink("127.0.0.1", interfaces)).toBe(true);
  });

  it("refuses one that had to be routed here", () => {
    expect(isOnLink("192.168.2.7", interfaces)).toBe(false);
    expect(isOnLink("8.8.8.8", interfaces)).toBe(false);
    expect(isOnLink("203.0.113.9", interfaces)).toBe(false);
  });

  it("refuses anything it cannot read as an address", () => {
    expect(isOnLink("", interfaces)).toBe(false);
    expect(isOnLink("not-an-address", interfaces)).toBe(false);
    expect(isOnLink("999.1.1.1", interfaces)).toBe(false);
    // IPv6 does not reach a udp4 socket except in mapped form, which does
    expect(isOnLink("::1", interfaces)).toBe(false);
    expect(isOnLink("::ffff:192.168.1.7", interfaces)).toBe(true);
  });
});

describe("clampBytes", () => {
  it("leaves anything already inside the budget alone", () => {
    expect(clampBytes("Ada's computer", 200)).toBe("Ada's computer");
    expect(clampBytes("", 200)).toBe("");
  });

  // The limit DNS-SD enforces is bytes, and `.slice()` counts UTF-16 code
  // units — so a name in a non-Latin script overran the record rather than
  // being truncated by it, and discovery failed silently for its owner.
  it("counts bytes, not characters", () => {
    const cjk = "小熊".repeat(60); // 2 chars, 6 bytes, x60
    expect(cjk.length).toBe(120);
    const clamped = clampBytes(cjk, 200);
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(clamped, "utf8")).toBeGreaterThan(194);
  });

  it("never cuts a character in half", () => {
    // an emoji is one code point in four bytes: with three bytes left it has
    // to be dropped whole, not turned into a replacement character
    const clamped = clampBytes("abc\u{1F600}", 6);
    expect(clamped).toBe("abc");
    expect(clamped).not.toContain("�");
    expect(clampBytes("\u{1F600}", 4)).toBe("\u{1F600}");
    expect(clampBytes("\u{1F600}", 3)).toBe("");
  });
});
