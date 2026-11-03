// Packets are built and read by hand, so the wire format is tested against the
// format rather than against our own encoder.
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

    const loop = Buffer.concat([header, Buffer.from([0xc0, 12]), suffix]);
    expect(decodeMessage(loop)).toBeNull();
  });

  it("returns null for anything it cannot read, rather than throwing", () => {
    expect(decodeMessage(Buffer.alloc(0))).toBeNull();
    expect(decodeMessage(Buffer.alloc(5))).toBeNull();
    expect(decodeMessage(Buffer.from([0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]))).toBeNull();
    const oneQuestion = Buffer.alloc(12);
    oneQuestion.writeUInt16BE(1, 4);
    expect(decodeMessage(Buffer.concat([oneQuestion, Buffer.from([40, 0x61])]))).toBeNull();
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
    // The service PTR is shared: RFC 6762 §10.2 forbids the cache-flush bit on it.
    expect(ptrRec.klass).toBe(0x0001);
    for (const record of [srvRec, txtRec, aRec]) expect(record.klass).toBe(0x8001);

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
    // TTL 0 withdraws a shared record (§10.1), not the flush bit.
    expect(parsed.records.find((r) => r.type === TYPE.PTR)!.klass).toBe(0x0001);
  });

  it("keeps the cache-flush bit off every record of a legacy-unicast reply", () => {
    const { ptr, srv, txt, addresses } = serviceRecords(service);
    const { id, questions } = decodeMessage(query(SERVICE_NAME, TYPE.PTR, { id: 42 }))!;
    const parsed = parseResponse(encodeResponse([ptr], [srv, txt, ...addresses], { id, questions, legacy: true }));

    // RFC 6762 §6.7: a legacy resolver has no mDNS cache and reads the top
    // class bit as part of the class.
    expect(parsed.id).toBe(42);
    expect(parsed.questionCount).toBe(1);
    expect(parsed.records).toHaveLength(4);
    for (const record of parsed.records) expect(record.klass).toBe(0x0001);
  });

  it("leaves the enumeration PTR unflushed too — it is shared widest of all", () => {
    const { answers } = answersFor(decodeMessage(query(SERVICE_ENUMERATION, TYPE.PTR))!, service);
    const [record] = parseResponse(encodeResponse(answers)).records;
    expect(record).toMatchObject({ name: SERVICE_ENUMERATION, type: TYPE.PTR, klass: 0x0001 });
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
    expect(ask(service.host, TYPE.SRV).answers).toEqual([]);
    const response = decodeMessage(encodeResponse(announcement(service)))!;
    expect(answersFor({ ...response, response: true, questions: [] }, service).answers).toEqual([]);
  });
});

describe("naming", () => {
  it("keeps an instance name to a single valid label", () => {
    expect(dnsLabel("Dr. Smith's computer")).toBe("Dr  Smith's computer");
    expect(dnsLabel("x".repeat(200)).length).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(dnsLabel("é".repeat(60)), "utf8")).toBeLessThanOrEqual(63);
    expect(dnsLabel("")).toBe("OpenMausBot");
    expect(dnsLabel("   ")).toBe("OpenMausBot");
  });

  it("claims a host name the system responder will not fight us for", () => {
    const name = defaultHostName("Milinds-MacBook-Pro");
    expect(name).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
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

// Over unicast on an ephemeral port: CI containers rarely route multicast.
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

      expect(parsed.id).toBe(42);
      expect(parsed.questionCount).toBe(1);
      expect(parsed.answerCount).toBe(1);
      expect(parsed.records[0]).toMatchObject({ name: SERVICE_NAME, type: TYPE.PTR });
      expect(parsed.records.some((r) => r.type === TYPE.SRV)).toBe(true);
    } finally {
      await responder.stop();
    }
  });

  it("answers a legacy resolver with the cache-flush bit nowhere in the packet", async () => {
    const responder = new MdnsResponder({ port: 0, multicast: false });
    expect(await responder.advertise(service)).toBe(true);
    try {
      const port = responder.address()!;
      const parsed = parseResponse(await askResponder(port, query(SERVICE_NAME, TYPE.PTR, { id: 42 })));

      // §6.7 also caps a legacy reply's TTL at 10 s, which the responder does
      // not yet meet; not asserted here.
      expect(parsed.records.length).toBeGreaterThan(1);
      for (const record of parsed.records) expect(record.klass).toBe(0x0001);
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
      // An unhandled 'error' on a dgram socket is an uncaught exception.
      noise.on("error", () => {});
      await new Promise<void>((resolve) => noise.bind(0, "127.0.0.1", resolve));
      // close() drops datagrams still queued, so each send is awaited.
      for (const junk of [Buffer.alloc(0), Buffer.from("hello"), Buffer.alloc(600, 0xff)]) {
        await new Promise<void>((resolve) => noise.send(junk, port, "127.0.0.1", () => resolve()));
      }
      await new Promise<void>((resolve) => noise.close(() => resolve()));

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
    await responder.stop();

    expect(await responder.advertise(service)).toBe(true);
    expect(responder.advertising).toBe(true);
    await responder.stop();
    expect(responder.advertising).toBe(false);
    expect(responder.address()).toBeNull();
  });
});

class FakeSocket extends EventEmitter {
  readonly ops: Array<{ op: "pin" | "send"; address: string; port?: number }> = [];
  readonly packets: Buffer[] = [];
  bind(_port: number, callback?: () => void) {
    callback?.();
  }
  setMulticastTTL(_ttl: number) {}
  addMembership(_group: string, _membershipInterface?: string) {}
  setMulticastInterface(multicastInterface: string) {
    this.ops.push({ op: "pin", address: multicastInterface });
  }
  send(packet: Buffer, port: number, address: string, callback?: (error: Error | null) => void) {
    this.ops.push({ op: "send", address, port });
    this.packets.push(packet);
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

// The fake's callbacks fire synchronously, so one later macrotask drains the
// first announcement.
const drained = () => new Promise((resolve) => setTimeout(resolve, 25));

// Pinning never reaches the wire in CI, so a recording socket is where it is asserted.
describe("multicast interface pinning", () => {
  /** `setMulticastInterface` redirects the sends after it, so the pin precedes
   * each send. */
  const pinnedBurst = homes.flatMap((address) => [
    { op: "pin", address },
    { op: "send", address: "224.0.0.251", port: 5353 },
  ]);

  it("pins every announcement and goodbye to each advertised interface, in order", async () => {
    const socket = new FakeSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    expect(await responder.advertise({ ...service, addresses: homes })).toBe(true);
    await drained();
    expect(socket.ops).toEqual(pinnedBurst);

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
        if (multicastInterface === "10.0.0.7") throw new Error("EADDRNOTAVAIL");
        super.setMulticastInterface(multicastInterface);
      }
    }
    const socket = new VanishingSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    await responder.advertise({ ...service, addresses: homes });
    await drained();
    try {
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

// Only a packet off the socket shows the caller passed mayFlush's policy down.
describe("cache-flush policy on the wire", () => {
  it("flushes what this machine owns on multicast, and never the shared PTR", async () => {
    const socket = new FakeSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    await responder.advertise({ ...service, addresses: homes });
    await drained();
    try {
      const parsed = parseResponse(socket.packets[0]);
      const klassOf = (type: number) => parsed.records.find((r) => r.type === type)!.klass;
      expect(klassOf(TYPE.PTR)).toBe(0x0001);
      for (const type of [TYPE.SRV, TYPE.TXT, TYPE.A]) expect(klassOf(type)).toBe(0x8001);
    } finally {
      await responder.stop();
    }
  });

  // The source port splits QU from legacy: a QU asker on 5353 has an mDNS cache
  // (§5.4), a legacy resolver does not (§6.7).
  const askDirectly = async (fromPort: number) => {
    const socket = new FakeSocket();
    const responder = new MdnsResponder({ socketFactory: () => socket });
    await responder.advertise(service);
    await drained();
    socket.packets.length = 0;
    try {
      socket.emit("message", query(INSTANCE, TYPE.SRV, { id: 9, unicast: true }), {
        address: "127.0.0.1",
        port: fromPort,
      });
      await drained();
      return parseResponse(socket.packets[0]).records.map((record) => record.klass);
    } finally {
      await responder.stop();
    }
  };

  it("keeps flushing for a QU asker on 5353, which has a cache to replace", async () => {
    expect(await askDirectly(5353)).toEqual([0x8001, 0x8001]);
  });

  it("drops the bit for the same QU question from a legacy port", async () => {
    expect(await askDirectly(40404)).toEqual([0x0001, 0x0001]);
  });
});

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

  it("puts a Windows PC's Wi-Fi ahead of its WSL and Hyper-V adapters", () => {
    expect(
      lanAddresses({
        "vEthernet (WSL (Hyper-V firewall))": [ipv4("172.19.96.1")],
        "vEthernet (Default Switch)": [ipv4("172.27.208.1")],
        "Wi-Fi": [ipv4("192.168.1.34")],
        "Loopback Pseudo-Interface 1": [ipv4("127.0.0.1", true)],
      }),
    ).toEqual(["192.168.1.34", "172.19.96.1", "172.27.208.1"]);
  });

  it("puts wired Ethernet ahead of Docker Desktop, VirtualBox, VMware and a VPN", () => {
    expect(
      lanAddresses({
        "vEthernet (WSL)": [ipv4("172.30.16.1")],
        "VirtualBox Host-Only Network": [ipv4("192.168.56.1")],
        "VMware Network Adapter VMnet8": [ipv4("192.168.80.1")],
        "OpenVPN Data Channel Offload": [ipv4("10.8.0.6")],
        Tailscale: [ipv4("100.101.102.103")],
        "Ethernet 2": [ipv4("10.0.0.15")],
      })[0],
    ).toBe("10.0.0.15");
  });

  it("reads localized Windows names: German WLAN, and an unrecognized one still beats a virtual adapter", () => {
    expect(
      lanAddresses({
        "vEthernet (Default Switch)": [ipv4("172.27.208.1")],
        WLAN: [ipv4("192.168.178.20")],
      }),
    ).toEqual(["192.168.178.20", "172.27.208.1"]);
    expect(
      lanAddresses({
        "vEthernet (WSL)": [ipv4("172.19.96.1")],
        "以太网": [ipv4("192.168.0.9")],
      }),
    ).toEqual(["192.168.0.9", "172.19.96.1"]);
  });

  it("puts a Linux machine's real interface ahead of docker0, bridges, libvirt and the tailnet", () => {
    expect(
      lanAddresses({
        docker0: [ipv4("172.17.0.1")],
        "br-3f2a1b9c0d4e": [ipv4("172.18.0.1")],
        virbr0: [ipv4("192.168.122.1")],
        veth1a2b3c: [ipv4("172.17.0.9")],
        tailscale0: [ipv4("100.101.1.2")],
        wlp2s0: [ipv4("192.168.1.20")],
        enp3s0: [ipv4("192.168.1.21")],
      }).slice(0, 2),
    ).toEqual(["192.168.1.20", "192.168.1.21"]);
  });
});

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

describe("isOnLink", () => {
  const interfaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
    en0: [{ family: "IPv4", address: "192.168.1.42", netmask: "255.255.255.0", internal: false }],
    ts0: [{ family: "IPv4", address: "100.102.178.88", netmask: "255.192.0.0", internal: false }],
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  it("accepts a source on a directly attached subnet", () => {
    expect(isOnLink("192.168.1.7", interfaces)).toBe(true);
    expect(isOnLink("192.168.1.42", interfaces)).toBe(true);
    expect(isOnLink("100.102.178.1", interfaces)).toBe(true);
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
    // IPv6 reaches a udp4 socket only in mapped form.
    expect(isOnLink("::1", interfaces)).toBe(false);
    expect(isOnLink("::ffff:192.168.1.7", interfaces)).toBe(true);
  });
});

describe("clampBytes", () => {
  it("leaves anything already inside the budget alone", () => {
    expect(clampBytes("Ada's computer", 200)).toBe("Ada's computer");
    expect(clampBytes("", 200)).toBe("");
  });

  it("counts bytes, not characters", () => {
    const cjk = "小熊".repeat(60); // 2 chars, 6 bytes, x60
    expect(cjk.length).toBe(120);
    const clamped = clampBytes(cjk, 200);
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(clamped, "utf8")).toBeGreaterThan(194);
  });

  it("never cuts a character in half", () => {
    const clamped = clampBytes("abc\u{1F600}", 6);
    expect(clamped).toBe("abc");
    expect(clamped).not.toContain("�");
    expect(clampBytes("\u{1F600}", 4)).toBe("\u{1F600}");
    expect(clampBytes("\u{1F600}", 3)).toBe("");
  });
});

describe("stop while an advertisement is still binding", () => {
  it("never publishes once stop() has returned", async () => {
    const socket = new FakeSocket();
    let bound: (() => void) | undefined;
    let closed = false;
    socket.bind = (_port: number, callback?: () => void) => {
      bound = callback;
    };
    socket.close = (callback?: () => void) => {
      closed = true;
      callback?.();
    };
    const responder = new MdnsResponder({ socketFactory: () => socket });
    const advertised = responder.advertise(service);
    await drained();
    expect(bound).toBeDefined();
    await responder.stop();
    bound?.();
    expect(await advertised).toBe(false);
    await drained();
    expect(socket.packets).toHaveLength(0);
    expect(responder.advertising).toBe(false);
    expect(closed).toBe(true);
  });

  it("never publishes when stop() runs during a re-advertisement's goodbye wait", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const responder = new MdnsResponder({ socketFactory: () => sockets.shift()! });
    expect(await responder.advertise(service)).toBe(true);
    await drained();
    const held: Array<() => void> = [];
    first.send = (_packet: Buffer, _port: number, _address: string, callback?: (error: Error | null) => void) => {
      held.push(() => callback?.(null));
    };
    const readvertised = responder.advertise(service);
    await responder.stop();
    for (const release of held.splice(0)) release();
    expect(await readvertised).toBe(false);
    await drained();
    expect(second.packets).toHaveLength(0);
    expect(responder.advertising).toBe(false);
  });
});
