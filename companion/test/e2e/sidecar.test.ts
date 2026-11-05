// The real sidecar process, a fake harness and a fake relay, driven by the reference phone.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admission, admissionHash, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../../src/e2e/credentials.ts";
import { TRANSPORT_DIRECT, TRANSPORT_RELAY } from "../../src/e2e/noise.ts";
import { dial } from "../../src/e2e/phone.ts";
import { SessionClosed, type E2ESession } from "../../src/e2e/session.ts";
import { ATTACHMENT_BYTES, attachmentByte, startFakeHarness, type FakeHarness } from "./fake-harness.ts";
import { startFakeRelay, type FakeRelay } from "./fake-relay.ts";

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const CONTROL_TOKEN = randomBytes(32).toString("base64url");
const LONG = process.env.OMB_E2E_LONG === "1";

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const waitFor = async <T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

let harness: FakeHarness;
let relay: FakeRelay;
let sidecar: ChildProcess;
let dir: string;
let companionPort: number;
let controlPort: number;
const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);
const hostId = randomBytes(16);
const hid = b64u(hostId);
const relayToken = () => {
  const iat = Math.floor(Date.now() / 1000);
  return mintRelayToken({ v: 1, kid: "k1", hid, iid: "test-install", iat, exp: iat + 12 * 3600 }, signingKey);
};

interface State {
  devices: Array<{ id: string; route: string | null; routes: string; e2eAt?: number }>;
  e2e: { enabled: boolean; relay: string; descriptor: { k: string; h?: string; r?: string[] } | null };
  token?: string;
}

async function control(method: string, path: string, body?: unknown): Promise<State> {
  const res = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
    method,
    headers: { "x-openmausbot-control-token": CONTROL_TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as State;
}

beforeAll(async () => {
  harness = await startFakeHarness();
  relay = await startFakeRelay({ keys });
  [companionPort, controlPort] = [await freePort(), await freePort()];
  dir = mkdtempSync(join(tmpdir(), "omb-e2e-sidecar-"));
  sidecar = spawn(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      OMB_PORT: String(harness.port),
      OMB_COMPANION_PORT: String(companionPort),
      OMB_CONTROL_PORT: String(controlPort),
      OMB_CONTROL_TOKEN: CONTROL_TOKEN,
      OMB_COMPANION_DIR: dir,
      OMB_COMPANION_NAME: "Test Mac",
      OMB_COMPANION_E2E: "1",
      OMB_COMPANION_BONJOUR: "0",
      OMB_COMPANION_RELAY_URL: relay.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.OMB_E2E_DEBUG) sidecar.stderr!.on("data", (chunk: Buffer) => process.stderr.write(`[sidecar] ${chunk}`));
  if (process.env.OMB_E2E_DEBUG) sidecar.stdout!.on("data", (chunk: Buffer) => process.stderr.write(`[sidecar] ${chunk}`));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    sidecar.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("companion  http://")) resolve();
    });
    sidecar.once("exit", (code) => reject(new Error(`sidecar exited ${code}: ${out}`)));
  });
  await control("PUT", "/e2e/relay", { hostId: hid, nodes: ["relay1.openmausbot.com"], relayToken: relayToken() });
  await waitFor(async () => (await control("GET", "/state")).e2e.relay === "connected");
}, 30_000);

afterAll(async () => {
  sidecar?.kill("SIGTERM");
  await relay?.close();
  await harness?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const transportKey = (state: State) => fromB64u(state.e2e.descriptor!.k)!;

function viaRelay(state: State, token: string) {
  const k = transportKey(state);
  return dial({
    url: `${relay.url}/v1/phone`,
    transportByte: TRANSPORT_RELAY,
    remoteStatic: k,
    psk: psk(credentialHash(token), keyId(k)),
    app: "test/1",
    relay: { hostId, adm: admission(credentialHash(token), hostId) },
  });
}

function direct(state: State, token: string) {
  const k = transportKey(state);
  return dial({ url: `ws://127.0.0.1:${companionPort}/v1/e2e`, transportByte: TRANSPORT_DIRECT, remoteStatic: k, psk: psk(credentialHash(token), keyId(k)), app: "test/1" });
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function http(session: E2ESession<never>, method: string, path: string, options: { token?: string; body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const body = typeof options.body === "string" ? Buffer.from(options.body) : options.body;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method,
        path,
        host: "companion",
        headers: {
          ...options.headers,
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(body ? { "content-length": String(body.length) } : {}),
        },
        createConnection: () => session.openStream(),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const json = (reply: Reply) => JSON.parse(reply.body.toString("utf8")) as Record<string, unknown>;

/** Opens the event stream and collects events until `until` says stop. */
function events(session: E2ESession<never>, token: string, lastEventId?: number) {
  const seen: Array<{ id: number; data: unknown }> = [];
  let buffer = "";
  let abort = () => {};
  const done = new Promise<void>((resolve) => {
    const req = request(
      {
        path: "/api/events",
        host: "companion",
        headers: { authorization: `Bearer ${token}`, ...(lastEventId ? { "last-event-id": String(lastEventId) } : {}) },
        createConnection: () => session.openStream(),
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const id = /^id: (\d+)$/m.exec(event);
            const data = /^data: (.*)$/m.exec(event);
            if (id && data) seen.push({ id: Number(id[1]), data: JSON.parse(data[1]) });
          }
        });
        res.on("close", resolve);
      },
    );
    req.on("error", () => resolve());
    abort = () => req.destroy();
    req.end();
  });
  return { seen, done, abort: () => abort() };
}

let deviceToken = "";
let deviceId = "";

describe("the sidecar's end-to-end connection", () => {
  it("pairs through the relay with the pairing token, then serves the new device in the same session", async () => {
    const state = await control("POST", "/pairing");
    const pairingToken = state.token!;
    expect(state.e2e.descriptor).toEqual({ v: 1, k: expect.any(String), h: hid, r: ["relay1.openmausbot.com"] });
    const adm = admissionHash(admission(credentialHash(pairingToken), hostId));
    await waitFor(() => relay.admitted(hid).has(adm));
    const session = await viaRelay(state, pairingToken);
    expect((await http(session, "GET", "/api/threads/t1/messages")).status).toBe(401);
    const paired = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: pairingToken, deviceName: "Test Phone" }), headers: { "content-type": "application/json" } });
    expect(paired.status).toBe(201);
    const body = json(paired) as { token: string; device: { id: string }; e2e: unknown };
    expect(body.e2e).toEqual(state.e2e.descriptor);
    deviceToken = body.token;
    deviceId = body.device.id;
    expect(json(await http(session, "GET", "/api/health", { token: deviceToken }))).toEqual({ app: "openmausbot" });
    const after = await control("GET", "/state");
    expect(after.devices).toEqual([expect.objectContaining({ id: deviceId, route: "relay", routes: "any", e2eAt: expect.any(Number) })]);
    session.shutdown();
  });

  it("carries a 4 MiB event, a 25 MiB upload and a Range read through the relay", async () => {
    const session = await viaRelay(await control("GET", "/state"), deviceToken);
    const stream = events(session, deviceToken);
    const big = "x".repeat(4 * 1024 * 1024 - 1024);
    const id = harness.emit({ type: "shot", blob: big });
    await waitFor(() => stream.seen.find((event) => event.id === id), 15_000);
    expect((stream.seen.find((event) => event.id === id)!.data as { blob: string }).blob.length).toBe(big.length);
    const upload = randomBytes(25 * 1024 * 1024);
    const stored = await http(session, "POST", "/api/files", { token: deviceToken, body: upload, headers: { "content-type": "application/octet-stream" } });
    expect(json(stored)).toEqual({ bytes: upload.length, sha256: createHash("sha256").update(upload).digest("hex") });
    const ranged = await http(session, "GET", "/api/attachments/voice.mp3", { token: deviceToken, headers: { range: "bytes=1000-1999" } });
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(Buffer.from(Array.from({ length: 1000 }, (_, index) => attachmentByte(1000 + index))))).toBe(true);
    expect(ATTACHMENT_BYTES).toBeGreaterThan(1999);
    stream.abort();
    session.shutdown();
  }, 60_000);

  it("is reached directly on /v1/e2e, labelled Wi-Fi, and the plain listener then refuses the device", async () => {
    const session = await direct(await control("GET", "/state"), deviceToken);
    expect((await http(session, "GET", "/api/health", { token: deviceToken })).status).toBe(200);
    expect((await control("GET", "/state")).devices[0].route).toBe("wifi");
    const plain = await fetch(`http://127.0.0.1:${companionPort}/api/threads/t1/messages`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(plain.status).toBe(426);
    expect(await plain.json()).toEqual({ error: "update_app" });
    expect((await fetch(`http://127.0.0.1:${companionPort}/api/health`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(200);
    session.shutdown();
  });

  it("refuses another device's token inside a session", async () => {
    const state = await control("POST", "/pairing");
    const other = await fetch(`http://127.0.0.1:${companionPort}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: state.token, deviceName: "Other" }),
    });
    const otherToken = ((await other.json()) as { token: string }).token;
    const session = await direct(state, deviceToken);
    expect((await http(session, "GET", "/api/health", { token: otherToken })).status).toBe(401);
    session.shutdown();
  });

  it(`waits ${LONG ? 105 : 35} s for headers without a deadline of its own`, async () => {
    harness.provideWaitMs = LONG ? 104_000 : 35_000;
    const session = await viaRelay(await control("GET", "/state"), deviceToken);
    const reply = await http(session, "POST", "/api/bots/b1/secret-cards/c1/provide", { token: deviceToken, body: "{}", headers: { "content-type": "application/json" } });
    expect(json(reply)).toEqual({ provided: true });
    session.shutdown();
    harness.provideWaitMs = 0;
  }, 120_000);

  it("resumes the event stream from its cursor after the relay dies, with no loss and no duplicates", async () => {
    const first = await viaRelay(await control("GET", "/state"), deviceToken);
    const before = events(first, deviceToken);
    const ids = [harness.emit({ n: 1 }), harness.emit({ n: 2 })];
    await waitFor(() => before.seen.some((event) => event.id === ids[1]));
    const port = relay.port;
    await relay.kill();
    expect(await first.closed).not.toBe(1000);
    const missed = harness.emit({ n: 3 });
    relay = await startFakeRelay({ keys, port });
    await waitFor(async () => (await control("GET", "/state")).e2e.relay === "connected", 10_000);
    await waitFor(() => relay.admitted(hid).size > 0);
    const second = await viaRelay(await control("GET", "/state"), deviceToken);
    const after = events(second, deviceToken, before.seen.at(-1)!.id);
    const next = harness.emit({ n: 4 });
    await waitFor(() => after.seen.some((event) => event.id === next));
    const all = [...before.seen, ...after.seen].map((event) => event.id).filter((id) => id >= ids[0]);
    expect(all).toEqual([ids[0], ids[1], missed, next]);
    after.abort();
    second.shutdown();
  }, 30_000);

  it("drops a device restricted to Wi-Fi and Tailscale from the relay at once, and keeps it direct", async () => {
    const state = await control("GET", "/state");
    const relayed = await viaRelay(state, deviceToken);
    const adm = admissionHash(admission(credentialHash(deviceToken), hostId));
    await control("PUT", `/devices/${deviceId}/routes`, { routes: "local" });
    expect(await relayed.closed).toBeGreaterThan(0);
    await waitFor(() => !relay.admitted(hid).has(adm));
    await expect(viaRelay(state, deviceToken)).rejects.toEqual(new SessionClosed(4404));
    const session = await direct(state, deviceToken);
    const endpoints = json(await http(session, "GET", "/api/companion/endpoints", { token: deviceToken }));
    expect(endpoints.e2e).toEqual({ v: 1, k: state.e2e.descriptor!.k, routes: "local" });
    session.shutdown();
    await control("PUT", `/devices/${deviceId}/routes`, { routes: "any" });
    await waitFor(() => relay.admitted(hid).has(adm));
  });

  it("closes a removed device's sessions within a second, with 4001", async () => {
    const state = await control("GET", "/state");
    const session = await direct(state, deviceToken);
    const started = Date.now();
    await control("DELETE", `/devices/${deviceId}`);
    expect(await session.closed).toBe(4001);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(direct(state, deviceToken)).rejects.toEqual(new SessionClosed(4001));
  });
});
