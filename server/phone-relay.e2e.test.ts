// The real server with OMB_PHONE_RELAY=1, a fake control plane and the fake relay, driven by the reference phone: the
// pairing code the owner makes on the server is redeemed through the relay, and the phone is then a session like any.
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { admission, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../companion/src/e2e/credentials.ts";
import { TRANSPORT_RELAY } from "../companion/src/e2e/noise.ts";
import { dial } from "../companion/src/e2e/phone.ts";
import { startFakeRelay, type FakeRelay } from "../companion/test/e2e/fake-relay.ts";
import { http, json, waitFor } from "../companion/test/e2e/rig.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const signingKey = generateKeyPairSync("ed25519").privateKey;
const hostId = randomBytes(16);
const credential = `omb_install_${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
const tokenRequests: unknown[] = [];

let relay: FakeRelay;
let controlPlane: Server;
let child: ChildProcess;
let dataDir: string;
let logPath: string;
let base: string;

beforeAll(async () => {
  relay = await startFakeRelay({ keys: new Map([["k1", ed25519RawPublicKey(signingKey)]]) });
  controlPlane = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method !== "POST" || req.url !== "/v1/installations/self/relay-token" || req.headers.authorization !== `Bearer ${credential}`) {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    }
    tokenRequests.push(JSON.parse(raw));
    const iat = Math.floor(Date.now() / 1000);
    const token = mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      token, hostId: b64u(hostId), nodes: ["relay1.openmausbot.com"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000,
    }));
  });
  await new Promise<void>((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "omb-phone-relay-e2e-"));
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const env = {
    ...verificationServerEnvironment(process.env, dataDir, port),
    OMB_PHONE_RELAY: "1",
    OMB_PHONE_RELAY_URL: relay.url,
    OMB_CONTROL_PLANE_URL: `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`,
    OMB_INSTALLATION_CREDENTIAL: credential,
  };
  logPath = join(dataDir, "server.log");
  const log = openSync(logPath, "a", 0o600);
  child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] });
  closeSync(log);
  await waitFor(async () => (await fetch(`${base}/api/health`).then((r) => r.json(), () => null) as { app?: string } | null)?.app === "openmausbot", 30_000);
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM", graceMs: 15_000 });
  await relay?.close();
  await new Promise((resolve) => controlPlane?.close(resolve));
  if (dataDir) await removeTempDir(dataDir);
});

const owner = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("serve --relay", () => {
  it("pairs a phone through the relay with the server's own pairing code, as a session of its own", async () => {
    await waitFor(async () => (await owner("/api/auth/pairing")).body.relay?.relay === "connected", 15_000);
    expect(readFileSync(logPath, "utf8")).toContain("phone relay: connected via relay1.openmausbot.com");
    // The control plane hears exactly the fields its strict schema takes.
    expect(tokenRequests[0]).toEqual({ appVersion: expect.stringMatching(/^\d+\.\d+\.\d+/), devices: { e2e: 0, legacy: 0 } });

    const minted = await owner("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["client"], label: "Pixel" }) });
    expect(minted.status).toBe(200);
    expect(minted.body.relay).toMatchObject({ relay: "connected", grant: "ok", phones: 0 });
    const invite = new URL(minted.body.inviteUrl);
    expect(invite.searchParams.get("token")).toBe(minted.body.credential);
    const descriptor = JSON.parse(fromB64u(invite.searchParams.get("e2e")!)!.toString("utf8")) as { k: string; h: string; r: string[] };
    expect(descriptor).toMatchObject({ h: b64u(hostId), r: ["relay1.openmausbot.com"] });
    const k = fromB64u(descriptor.k)!;
    const phone = (token: string) => dial({
      url: `${relay.url}/v1/phone`, transportByte: TRANSPORT_RELAY, remoteStatic: k, psk: psk(credentialHash(token), keyId(k)), app: "test/1",
      relay: { hostId, adm: admission(credentialHash(token), hostId) },
    });

    const pairing = await waitFor(() => phone(minted.body.credential).catch(() => null), 8_000);
    const paired = await http(pairing, "POST", "/api/pair", { body: JSON.stringify({ credential: minted.body.credential, deviceName: "Pixel" }), headers: { "content-type": "application/json" } });
    expect(paired.status).toBe(200);
    const reply = json(paired) as { token: string; device: { id: string; name: string }; serverName: string; e2e: unknown };
    expect(reply.device.name).toBe("Pixel");
    expect(reply.e2e).toEqual(descriptor);
    pairing.shutdown();

    const session = await waitFor(() => phone(reply.token).catch(() => null), 8_000);
    expect(json(await http(session, "GET", "/api/auth/session", { token: reply.token }))).toMatchObject({ kind: "session", id: reply.device.id, scopes: ["client"] });
    // No session, a loopback Host and the CLI's owner header: still a remote request through the relay.
    const spoofed = await http(session, "GET", "/api/auth/session", { headers: { host: base.slice("http://".length), "x-openmausbot-cli": "1" } });
    expect(spoofed.status).toBe(403);
    // Chat-only stays chat-only: the server's own scope rule answers.
    expect((await http(session, "POST", "/api/auth/pairing", { token: reply.token, body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);

    // `openmausbot devices revoke`: the phone hears it inside the encryption.
    expect((await owner(`/api/auth/sessions/${reply.device.id}`, { method: "DELETE" })).status).toBe(200);
    await session.closed;
    expect(session.removed).toBe(true);
    expect((await owner("/api/auth/pairing")).body.relay.phones).toBe(0);
  }, 60_000);
});
