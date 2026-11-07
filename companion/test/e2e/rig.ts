// The real sidecar process in front of a fake harness, reached through a relay (the real relay process, or the fake
// one for attacks), driven by the reference phone.
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { admission, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../../src/e2e/credentials.ts";
import { TRANSPORT_DIRECT, TRANSPORT_RELAY } from "../../src/e2e/noise.ts";
import { dial } from "../../src/e2e/phone.ts";
import type { E2ESession } from "../../src/e2e/session.ts";
import { startFakeHarness, type FakeHarness } from "./fake-harness.ts";

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const RELAY_MAIN = fileURLToPath(new URL("../../../relay/src/main.ts", import.meta.url));

/** Distinct ports: each is held until all are found, so two calls can't hand back the same one. */
export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise<ReturnType<typeof createServer>>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  })));
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

export const freePort = async () => (await freePorts(1))[0];

export const waitFor = async <T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

export interface RelayProcess {
  url: string;
  port: number;
  pid: number;
  stop(): Promise<void>;
}

/** `relay/src/main.ts` as a child process, as on the boxes, holding only the public token key. */
export async function spawnRelay(publicKey: Buffer, port: number): Promise<RelayProcess> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RELAY_MAIN], {
    env: { PATH: process.env.PATH ?? "", RELAY_HOST: "127.0.0.1", RELAY_PORT: String(port), RELAY_NODE: "relay1", RELAY_TOKEN_KEYS: JSON.stringify({ k1: b64u(publicKey) }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (chunk: Buffer) => (err += chunk));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk;
      if (out.split("\n").some((line) => line.includes('"ev":"start"'))) resolve();
    });
    child.once("exit", (code) => reject(new Error(`relay exited ${code}: ${err}`)));
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    pid: child.pid ?? 0,
    async stop() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

export interface State {
  devices: Array<{ id: string; route: string | null; routes: string; e2eAt?: number }>;
  e2e: { enabled: boolean; relay: string; descriptor: { k: string; h?: string; r?: string[] } | null };
  token?: string;
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface Rig {
  harness: FakeHarness;
  companionPort: number;
  sidecarPid: number;
  hostId: Buffer;
  hid: string;
  signingPublicKey: Buffer;
  control(method: string, path: string, body?: unknown): Promise<State>;
  relayToken(): string;
  viaRelay(state: State, token: string): Promise<E2ESession<never>>;
  direct(state: State, token: string): Promise<E2ESession<never>>;
  stop(): Promise<void>;
}

/** `relayUrl` is where the sidecar's relay client dials, for every node. */
export async function startRig(relayUrl: (signingPublicKey: Buffer) => Promise<string>): Promise<Rig> {
  const harness = await startFakeHarness();
  const signingKey = generateKeyPairSync("ed25519").privateKey;
  const signingPublicKey = ed25519RawPublicKey(signingKey);
  const url = await relayUrl(signingPublicKey);
  const hostId = randomBytes(16);
  const hid = b64u(hostId);
  const controlToken = randomBytes(32).toString("base64url");
  const [companionPort, controlPort, webhookPort] = await freePorts(3);
  const dir = mkdtempSync(join(tmpdir(), "omb-e2e-sidecar-"));
  const sidecar: ChildProcess = spawn(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      OMB_PORT: String(harness.port),
      OMB_WEBHOOK_PORT: String(webhookPort),
      OMB_COMPANION_PORT: String(companionPort),
      OMB_CONTROL_PORT: String(controlPort),
      OMB_CONTROL_TOKEN: controlToken,
      OMB_COMPANION_DIR: dir,
      OMB_COMPANION_NAME: "Test Mac",
      OMB_COMPANION_E2E: "1",
      OMB_COMPANION_BONJOUR: "0",
      OMB_COMPANION_RELAY_URL: url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.OMB_E2E_DEBUG) for (const stream of [sidecar.stdout!, sidecar.stderr!]) stream.on("data", (chunk: Buffer) => process.stderr.write(`[sidecar] ${chunk}`));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    sidecar.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("companion  http://")) resolve();
    });
    sidecar.stderr!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    sidecar.once("exit", (code) => reject(new Error(`sidecar exited ${code}: ${out}`)));
  });
  const relayToken = () => {
    const iat = Math.floor(Date.now() / 1000);
    return mintRelayToken({ v: 1, kid: "k1", hid, iid: "test-install", iat, exp: iat + 12 * 3600 }, signingKey);
  };
  const control = async (method: string, path: string, body?: unknown): Promise<State> => {
    const res = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
      method,
      headers: { "x-openmausbot-control-token": controlToken, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as State;
  };
  await control("PUT", "/e2e/relay", { hostId: hid, nodes: ["relay1.openmausbot.com"], relayToken: relayToken() });
  await waitFor(async () => (await control("GET", "/state")).e2e.relay === "connected", 10_000);
  const transportKey = (state: State) => fromB64u(state.e2e.descriptor!.k)!;
  return {
    harness,
    companionPort,
    sidecarPid: sidecar.pid ?? 0,
    hostId,
    hid,
    signingPublicKey,
    control,
    relayToken,
    viaRelay: (state, token) => {
      const k = transportKey(state);
      return dial({
        url: `${url}/v1/phone`,
        transportByte: TRANSPORT_RELAY,
        remoteStatic: k,
        psk: psk(credentialHash(token), keyId(k)),
        app: "test/1",
        relay: { hostId, adm: admission(credentialHash(token), hostId) },
      });
    },
    direct: (state, token) => {
      const k = transportKey(state);
      return dial({ url: `ws://127.0.0.1:${companionPort}/v1/e2e`, transportByte: TRANSPORT_DIRECT, remoteStatic: k, psk: psk(credentialHash(token), keyId(k)), app: "test/1" });
    },
    async stop() {
      sidecar.kill("SIGTERM");
      await harness.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function http(
  session: E2ESession<never>,
  method: string,
  path: string,
  options: { token?: string; body?: Buffer | string; headers?: Record<string, string> } = {},
): Promise<Reply> {
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

export const json = (reply: Reply) => JSON.parse(reply.body.toString("utf8")) as Record<string, unknown>;

/** Opens the event stream and collects events as they come. */
export function events(session: E2ESession<never>, token: string, lastEventId?: number) {
  const seen: Array<{ id: number; data: unknown }> = [];
  /** Events with no `id:`: the ones the sidecar itself sends. */
  const pushed: Array<{ at: number; data: Record<string, unknown> }> = [];
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
            else if (data) pushed.push({ at: Date.now(), data: JSON.parse(data[1]) });
          }
        });
        res.on("close", resolve);
      },
    );
    req.on("error", () => resolve());
    abort = () => req.destroy();
    req.end();
  });
  return { seen, pushed, done, abort: () => abort() };
}

/** Pairs a phone through the relay with a fresh pairing window; returns its device token and id. */
export async function pairViaRelay(rig: Rig): Promise<{ token: string; id: string; session: E2ESession<never> }> {
  const state = await rig.control("POST", "/pairing");
  const pairingToken = state.token!;
  const session = await waitFor(() => rig.viaRelay(state, pairingToken).catch(() => null), 5_000);
  const paired = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: pairingToken, deviceName: "Test Phone" }), headers: { "content-type": "application/json" } });
  if (paired.status !== 201) throw new Error(`pairing failed: ${paired.status} ${paired.body}`);
  const body = json(paired) as { token: string; device: { id: string } };
  // The relay admits the new device a moment after pairing.
  await waitFor(() => rig.viaRelay(state, body.token).then((check) => (check.shutdown(), true), () => null), 5_000);
  return { token: body.token, id: body.device.id, session };
}
