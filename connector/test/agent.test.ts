import { createServer, type Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { Agent, backoffMs, connectUrl, savedConfig, transferAuthorization, type Refusal } from "../src/agent.ts";
import type { AuditEvent } from "../src/audit.ts";
import { adminOrigin, enroll } from "../src/enroll.ts";
import { serveRequest } from "../src/home-requests.ts";
import { CLOSE_KEY_COPIED, CLOSE_UNAUTHORIZED, type ConfigPayload, type HostFacts, type Job, type JobReply } from "../src/protocol.ts";
import { generateKeyPair, unseal } from "../src/signed.ts";
import type { AgentRecord, ConfigRecord, StatusRecord } from "../src/state.ts";
import { FakeAdmin } from "./fake-admin.ts";

const host: HostFacts = { os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0", arch: "x86_64", cpus: 4, memMb: 16_000, diskGb: 120, docker: "28.0.4", apparmor: true, userns: true };
const connector = { version: "1.0.0", protocol: 2 as const, image: null };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fakeAdmin(): Promise<FakeAdmin> {
  const admin = new FakeAdmin();
  await admin.listen();
  cleanups.push(() => admin.close());
  return admin;
}

interface AgentFixture {
  agent: Agent;
  record: { current: AgentRecord };
  count: { value: number };
  handled: Job[];
  statuses: Partial<StatusRecord>[];
  lines: string[];
  refusals: Refusal[];
  audits: AuditEvent[];
  saved: { config: ConfigRecord | null };
  retries: number[];
}

function makeConnector(record: AgentRecord, options: {
  handle?: (job: Job) => Promise<JobReply | null>; count?: { value: number }; now?: () => number; homePort?: () => number; deadMs?: number; pingMs?: number;
} = {}): AgentFixture {
  const fixture: AgentFixture = {
    agent: null as unknown as Agent, record: { current: record }, count: options.count ?? { value: 0 }, handled: [], statuses: [], lines: [], refusals: [], audits: [],
    saved: { config: null }, retries: [],
  };
  fixture.agent = new Agent({
    identity: () => fixture.record.current, log: (line) => fixture.lines.push(line), heartbeatMs: 100, random: () => 0, now: options.now,
    nextCount: () => ++fixture.count.value,
    saveAdminKeys: (keys) => { fixture.record.current = { ...fixture.record.current, adminKeys: keys }; },
    config: { saved: () => fixture.saved.config, save: (config) => { fixture.saved.config = config; } },
    heartbeat: async () => ({ heartbeat: { host: { ...host, diskTotalGb: 200, memAvailableMb: 9000, load1: 0.1, uptimeS: 50, clockSkewS: 0, checks: [] }, home: { state: "running", image: null, health: null }, connector } }),
    handle: options.handle ?? (async (job) => {
      fixture.handled.push(job);
      return { id: job.id, ok: true, result: { host: { ...host } } } as unknown as JobReply;
    }),
    stream: (stream, accept) => serveRequest(stream, accept, {
      connectHome: () => new Promise<Duplex>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: options.homePort?.() ?? 9 });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      }),
      record: (event) => fixture.audits.push(event),
    }),
    refused: (refusal) => fixture.refusals.push(refusal),
    status: (patch) => fixture.statuses.push(patch),
    // Every wait of a second or more (a retry, the handshake deadline, a ping) passes in 30 ms; each is recorded.
    setTimer: (callback, ms) => {
      fixture.retries.push(ms);
      return setTimeout(callback, ms >= 1000 ? 30 : ms);
    },
    ...(options.deadMs ? { deadMs: options.deadMs } : {}),
    ...(options.pingMs ? { pingMs: options.pingMs } : {}),
  });
  cleanups.push(() => fixture.agent.stop());
  return fixture;
}

async function connected(options: Parameters<typeof makeConnector>[1] & { accepted?: boolean } = {}) {
  const admin = await fakeAdmin();
  const record = await enroll({ admin: admin.origin, code: admin.mintCode(), host, connector });
  if (options.accepted) admin.boxes.get(record.boxId)!.state = "accepted";
  const fixture = makeConnector(record, options);
  fixture.agent.start();
  await until(() => fixture.agent.connected);
  return { admin, ...fixture };
}

describe("the connector's connection to MausBot", () => {
  it("enrols once with the one-time code and a key it made, pins the Admin's keys, and proves its key on every connection", async () => {
    const { admin, record, statuses, lines, agent } = await connected();
    const box = admin.boxes.get(record.current.boxId)!;
    expect(box).toMatchObject({ publicKey: record.current.publicKey, state: "pending", enroll: { host, connector, publicKey: record.current.publicKey } });
    expect(record.current).toMatchObject({ version: 2, admin: admin.origin, teamId: box.teamId, adminKeys: admin.publicKeys });
    expect(agent.state).toBe("pending");
    await until(() => admin.heartbeats.length >= 3);
    expect(admin.heartbeats[0]).toMatchObject({ home: { state: "running" }, connector: { protocol: 2 }, host: { arch: "x86_64" } });
    expect(statuses).toContainEqual(expect.objectContaining({ connected: true, unauthorized: false }));
    expect(statuses).toContainEqual({ boxState: "pending" });
    admin.drop();
    await until(() => admin.connections.length === 2 && agent.connected);
    expect(admin.connections.map((connection) => connection.count)).toEqual([1, 2]);
    expect(lines.join("\n")).not.toContain(record.current.privateKey);
    expect(lines).toContain("connected to MausBot (waiting for the team's Owner to accept this server)");
    await expect(enroll({ admin: admin.origin, code: [...admin.codes][0] ?? "MB-USED-CODE", host, connector })).rejects.toThrow(
      "This code isn't valid anymore: a code works once, for one hour. Make a new one in MausBot and run the install command again.");
  });

  it("drops a connection whose hello no key it pinned signed, and never takes a job on it", async () => {
    const admin = await fakeAdmin();
    const record = await enroll({ admin: admin.origin, code: admin.mintCode(), host, connector });
    admin.impostor = generateKeyPair();
    const fixture = makeConnector(record);
    fixture.agent.start();
    await until(() => admin.connections.length >= 2);
    expect(fixture.agent.connected).toBe(false);
    expect(fixture.statuses).not.toContainEqual(expect.objectContaining({ connected: true }));
    expect(fixture.statuses).toContainEqual({ lastError: `the MausBot at ${admin.origin} did not prove it holds MausBot's key (the signature does not verify)` });
    expect(fixture.lines).toContain("dropping the connection to MausBot: MausBot's hello did not verify: the signature does not verify");
    admin.impostor = null;
    await until(() => fixture.agent.connected);
  });

  it("runs a job only when the Admin signed it for this box and it is fresh by the Admin's clock, whatever this server's clock says", async () => {
    const { admin, record, handled, refusals } = await connected({ accepted: true, now: () => Date.now() - 3 * 3600_000 });
    expect((await admin.job("host-health", {}, "signed-1")).ok).toBe(true);
    expect(handled.map((job) => job.id)).toEqual(["signed-1"]);

    admin.send({ id: "bare-1", type: "stop", args: {} });
    expect(await admin.job("host-health", {}, "wrong-box-1", { box: "box_someoneelse0" })).toMatchObject({ ok: false, error: { code: "wrong_box" } });
    expect(await admin.job("host-health", {}, "old-1", { ageMs: 16 * 60_000 })).toMatchObject({ ok: false, error: { code: "expired_job" } });
    admin.send({ job: admin.signJob(record.current.boxId, { id: "stranger-1", type: "stop", args: {} }, { key: generateKeyPair() }) });
    admin.send({ job: "not.an-envelope" });
    expect((await admin.job("status", {}, "signed-2")).ok).toBe(true);
    expect(handled.map((job) => job.id)).toEqual(["signed-1", "signed-2"]);
    expect(refusals).toEqual([
      { code: "unsigned_job", message: "a job MausBot did not sign" },
      { code: "wrong_box", message: "the job was signed for another server", id: "wrong-box-1", type: "host-health" },
      { code: "expired_job", message: "the job's signature is too old", id: "old-1", type: "host-health" },
      { code: "unsigned_job", message: "a job MausBot did not sign (the signature does not verify)" },
      { code: "unsigned_job", message: "a job MausBot did not sign (not an envelope)" },
    ]);
    expect(admin.replies.map((reply) => reply.id)).not.toContain("bare-1");
    expect(admin.replies.map((reply) => reply.id)).not.toContain("stranger-1");
  });

  it("keeps a server the team's Owner has not accepted to jobs that only read, until the Owner accepts it", async () => {
    const { admin, record, handled, agent } = await connected();
    expect((await admin.job("status", {}, "read-1")).ok).toBe(true);
    expect(await admin.job("stop", {}, "stop-1")).toEqual({ id: "stop-1", ok: false, error: { code: "pending_box", message: "The team's Owner has not accepted this server in MausBot yet." } });
    admin.accept(record.current.boxId);
    await until(() => agent.state === "accepted");
    expect((await admin.job("stop", {}, "stop-2")).ok).toBe(true);
    expect(handled.map((job) => job.id)).toEqual(["read-1", "stop-2"]);
  });

  it("answers each job once: the same id again gets the same reply, and never a second run", async () => {
    const { admin, handled } = await connected({ accepted: true });
    const first = await admin.job("host-health", {}, "same-id");
    admin.send({ job: admin.signJob(admin.liveBox!, { id: "same-id", type: "host-health", args: {} }) });
    await until(() => (admin.replyCounts.get("same-id") ?? 0) >= 2);
    expect(handled).toHaveLength(1);
    expect(admin.replies.filter((reply) => reply.id === "same-id")).toEqual([first]);
  });

  it("keeps a reply made while the connection is down, comes back with backoff, and delivers it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { admin, retries, agent } = await connected({ accepted: true, handle: async (job) => {
      await gate;
      return { id: job.id, ok: true, result: { host: { ...host } } } as unknown as JobReply;
    } });
    const reply = admin.replyTo("slow-1");
    admin.send({ job: admin.signJob(admin.liveBox!, { id: "slow-1", type: "host-health", args: {} }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    admin.drop();
    await until(() => !agent.connected);
    release();
    await until(() => agent.connected);
    expect((await reply).ok).toBe(true);
    expect(retries).toContain(backoffMs(0, 0));
  });

  it("loses its connection the moment its key is revoked, then slows right down and says why", async () => {
    const { admin, record, statuses, lines, retries } = await connected({ accepted: true });
    admin.revoke(record.current.boxId);
    await until(() => statuses.some((status) => status.unauthorized === true));
    expect(admin.closes).toEqual([{ boxId: record.current.boxId, code: CLOSE_UNAUTHORIZED }]);
    expect(statuses).toContainEqual({ connected: false, unauthorized: true, lastError: "MausBot no longer knows this server" });
    expect(lines).toContain("MausBot no longer knows this server; run the install command again with a new code to connect it");
    expect(retries).toContain(5 * 60_000);
  });

  it("a copy of the key gives itself away by its connection count: the Admin revokes the key, and both servers are shut out", async () => {
    const { admin, record, agent, count, statuses } = await connected({ accepted: true });
    // A disk copy taken now: the same key, the same count on disk.
    const copy = makeConnector(record.current, { count: { value: count.value - 1 } });
    copy.agent.start();
    await until(() => admin.boxes.get(record.current.boxId)!.revoked === "copied");
    await until(() => statuses.some((status) => status.unauthorized === true) && copy.statuses.some((status) => status.unauthorized === true));
    expect(agent.connected).toBe(false);
    expect(copy.agent.connected).toBe(false);
    expect(admin.closes).toContainEqual({ boxId: record.current.boxId, code: CLOSE_KEY_COPIED });
    for (const status of [...statuses, ...copy.statuses].filter((entry) => entry.unauthorized)) {
      expect(status.lastError).toBe("MausBot saw another server use this server's key, so it stopped trusting the key");
    }
  });

  it("keeps the Admin's newest signed schedule and policy on its disk, and only those it can verify", async () => {
    const { admin, record, saved, agent } = await connected({ accepted: true });
    await until(() => agent.state === "accepted");
    const box = record.current.boxId;
    admin.sendConfig(box, { version: 3, policy: { offlineHours: 48 } });
    await until(() => saved.config?.version === 3);
    admin.sendConfig(box, { version: 2, policy: { offlineHours: 1 } });
    admin.send({ config: "forged.config" });
    await admin.job("status", {});
    expect(saved.config?.version).toBe(3);
    const kept = savedConfig(saved.config, record.current) as ConfigPayload;
    expect(kept).toMatchObject({ version: 3, state: "accepted", policy: { offlineHours: 48 }, schedule: { ring: "standard", window: { timeZone: "Europe/Berlin" } } });
    const [body, signature] = saved.config!.envelope.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")), policy: { offlineHours: 720 } })).toString("base64url");
    expect(savedConfig({ ...saved.config!, envelope: `${tampered}.${signature}` }, record.current)).toBeNull();
    expect(savedConfig(saved.config, { ...record.current, boxId: "box_another00000" })).toBeNull();
  });

  it("pins the Admin's new keys only from a hello one of its pinned keys signed", async () => {
    const { admin, record, agent } = await connected({ accepted: true });
    const next = generateKeyPair();
    admin.keys.k2 = next;
    admin.announce = { k1: admin.keys.k1!.publicKey, k2: next.publicKey };
    admin.drop();
    await until(() => Object.keys(record.current.adminKeys).length === 2);
    admin.signingKid = "k2";
    admin.drop();
    await until(() => admin.connections.length === 3 && agent.connected);
    expect((await admin.job("host-health", {})).ok).toBe(true);
  });

  it("carries the Admin's requests to the home and nowhere else, one per stream, each written to the audit log", async () => {
    const seen: { method: string; url: string; host: string; body: string }[] = [];
    const home: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, host: req.headers.host!, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(req.url === "/api/cloud/pairing" ? 200 : 204, { "content-type": "application/json" }).end(req.url === "/api/cloud/pairing" ? '{"code":"SECRET-PAIRING-CODE"}' : undefined);
      });
    });
    await new Promise<void>((resolve) => home.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => home.close(() => resolve())));
    let port = (home.address() as AddressInfo).port;
    const { admin, audits } = await connected({ accepted: true, homePort: () => port });
    expect(await admin.fetch("/api/cloud/health?x=1", { host: "mausbot.acme.example" })).toEqual({ status: 204, body: "" });
    const claim = JSON.stringify({ label: "Ada's laptop", member: { email: "ada@acme.example", role: "admin" } });
    expect(await admin.fetch("/api/cloud/pairing", { method: "POST", body: claim, host: "mausbot.acme.example" })).toEqual({ status: 200, body: '{"code":"SECRET-PAIRING-CODE"}' });
    expect(seen).toEqual([
      { method: "GET", url: "/api/cloud/health?x=1", host: "mausbot.acme.example", body: "" },
      { method: "POST", url: "/api/cloud/pairing", host: "mausbot.acme.example", body: claim },
    ]);
    port = 9;
    expect(await admin.fetch("/api/cloud/health")).toEqual({ status: 502, body: "" });
    expect(audits).toEqual([
      { event: "request", by: "admin", method: "GET", path: "/api/cloud/health", status: 204 },
      { event: "request", by: "admin", method: "POST", path: "/api/cloud/pairing", status: 200, member: { email: "ada@acme.example", role: "admin", device: "Ada's laptop" } },
      { event: "request", by: "admin", method: "GET", path: "/api/cloud/health", status: 502 },
    ]);
    expect(JSON.stringify(audits)).not.toContain("SECRET-PAIRING-CODE");
  });

  it("comes back after the Admin's restart when the Admin said to, not at once", async () => {
    const { admin, agent, retries } = await connected({ accepted: true });
    admin.restarting(4000, 0);
    await until(() => !agent.connected);
    await until(() => retries.includes(4000));
    await until(() => agent.connected);
  });

  it("drops a connection the Admin went silent on, and opens a new one", async () => {
    const { admin, agent, lines } = await connected({ accepted: true, pingMs: 50, deadMs: 300 });
    admin.freeze();
    await until(() => lines.includes("dropping the connection to MausBot: nothing from MausBot for 0 s"));
    await until(() => admin.connections.length === 2 && agent.connected);
  });

  it("signs a transfer token for one job that the Admin can check against the box's key", async () => {
    const { record } = await connected();
    const header = transferAuthorization(record.current, "export-7", 1_000);
    expect(header.startsWith("Box ")).toBe(true);
    const opened = unseal(header.slice(4), { box: record.current.publicKey });
    expect(opened).toEqual({ ok: true, payload: { t: "transfer", box: record.current.boxId, job: "export-7", iat: 1_000, exp: 601_000, kid: "box" } });
    expect(unseal(header.slice(4), { box: generateKeyPair().publicKey }).ok).toBe(false);
  });

  it("connects to the Admin's own origin over wss, and to a test Admin on loopback over ws only", () => {
    expect(connectUrl("https://cloud.example.test")).toBe("wss://cloud.example.test/api/cloud/box/v1/connect");
    expect(connectUrl("http://127.0.0.1:8123")).toBe("ws://127.0.0.1:8123/api/cloud/box/v1/connect");
    expect(adminOrigin("https://cloud.example.test/")).toBe("https://cloud.example.test");
    expect(() => adminOrigin("http://cloud.example.test")).toThrow("is not a MausBot address this connector may use.");
    expect(() => adminOrigin(undefined)).toThrow("The install command did not say which MausBot to connect to.");
  });

  it("says plainly when MausBot cannot be reached at enrolment", async () => {
    await expect(enroll({ admin: "http://127.0.0.1:9", code: "MB-1A2B-3C4D", host, connector })).rejects.toThrow(/^This server can't reach MausBot at http:\/\/127\.0\.0\.1:9 /);
    await expect(enroll({ admin: "http://127.0.0.1:9", code: "MB 1A2B", host, connector })).rejects.toThrow("the code is the one-time code MausBot shows next to the install command");
  });

  it("refuses a job before the handshake, and a binary message before it, by closing the connection", async () => {
    const { admin, agent } = await connected({ accepted: true });
    expect(agent.connected).toBe(true);
    admin.sendBinary(new Uint8Array([0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    await until(() => admin.connections.length === 2 && agent.connected);
  });
});

