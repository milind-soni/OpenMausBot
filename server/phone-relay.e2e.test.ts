// The real server with OMB_PHONE_RELAY=1, a fake control plane and the fake relay, driven by the reference phone: the
// pairing code the owner makes on the server is redeemed through the relay, and the phone is then a session like any.
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { admission, b64u, credentialHash, fromB64u, keyId, psk } from "../companion/src/e2e/credentials.ts";
import { TRANSPORT_RELAY } from "../companion/src/e2e/noise.ts";
import { dial } from "../companion/src/e2e/phone.ts";
import type { FakeRelay } from "../companion/test/e2e/fake-relay.ts";
import { http, json, waitFor } from "../companion/test/e2e/rig.ts";
import { startPhoneRelayRig, type PhoneRelayRig } from "./testing/phone-relay-rig.ts";

let rig: PhoneRelayRig;
let relay: FakeRelay;
let hostId: Buffer;
let credential: string;
let tokenRequests: unknown[];
let logPath: string;
let base: string;
const dockerSocket = join(tmpdir(), `omb-relay-e2e-docker-${process.pid}.sock`);
const boot = (extra?: Record<string, string>) => rig.boot(extra);

beforeAll(async () => {
  rig = await startPhoneRelayRig();
  ({ relay, hostId, credential, tokenRequests } = rig);
  // As Docker runs it: its Caddy reaches the server over this socket, which is no tunnel.
  ({ logPath, base } = await boot({ OMB_TUNNEL_SOCKET: dockerSocket }));
}, 60_000);

afterAll(async () => {
  await rig?.close();
  rmSync(dockerSocket, { force: true });
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
    expect(tokenRequests[0]).toEqual({ appVersion: expect.stringMatching(/^\d+\.\d+\.\d+/), devices: { e2e: 0, legacy: 0 }, kind: "server" });

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

  it("stays off on a server that serves a tunnel or runs on a fleet credential, and asks the control plane nothing", async () => {
    const asked = tokenRequests.length;
    const socket = join(tmpdir(), `omb-relay-e2e-${process.pid}-${Date.now()}.sock`);
    const tunnel = await boot({ OMB_SERVES_TUNNEL: "1", OMB_TUNNEL_SOCKET: socket });
    onTestFinished(() => rmSync(socket, { force: true }));
    const fleet = await boot({ OMB_INSTALLATION_CREDENTIAL: credential });
    for (const server of [tunnel, fleet]) {
      const status = await (await fetch(`${server.base}/api/auth/pairing`)).json() as { relay?: { grant: string; reason?: string } };
      expect(status.relay).toMatchObject({ grant: "tunnel", reason: expect.any(String) });
      const minted = await (await fetch(`${server.base}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["client"] }) })).json() as { inviteUrl: string | null };
      expect(minted.inviteUrl ?? "").not.toContain("e2e=");
      expect(readFileSync(server.logPath, "utf8")).toMatch(/phone relay: off: .*login --relay/);
    }
    expect(tokenRequests.length).toBe(asked);
  }, 90_000);
});
