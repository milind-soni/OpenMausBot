// The real sidecar process and the real relay process, with a fake harness, driven by the reference phone.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionClosed } from "../../src/e2e/session.ts";
import { attachmentByte } from "./fake-harness.ts";
import { events, freePort, http, json, pairViaRelay, spawnRelay, startRig, waitFor, type RelayProcess, type Rig } from "./rig.ts";

const LONG = process.env.OMB_E2E_LONG === "1";
let rig: Rig;
let relay: RelayProcess;
let relayPort: number;
let deviceToken = "";
let deviceId = "";

beforeAll(async () => {
  relayPort = await freePort();
  rig = await startRig(async (publicKey) => {
    relay = await spawnRelay(publicKey, relayPort);
    return relay.url;
  });
}, 30_000);

afterAll(async () => {
  await rig?.stop();
  await relay?.stop();
});

const state = () => rig.control("GET", "/state");

describe("the sidecar's end-to-end connection, through the real relay", () => {
  it("pairs through the relay with the pairing token, then serves the new device in the same session", async () => {
    const before = await rig.control("POST", "/pairing");
    expect(before.e2e.descriptor).toEqual({ v: 1, k: expect.any(String), h: rig.hid, r: ["relay1.openmausbot.com"] });
    await rig.control("DELETE", "/pairing");
    const paired = await pairViaRelay(rig);
    deviceToken = paired.token;
    deviceId = paired.id;
    expect((await http(paired.session, "GET", "/api/threads/t1/messages", { token: "omb_other" })).status).toBe(401);
    expect(json(await http(paired.session, "GET", "/api/health", { token: deviceToken }))).toEqual({ app: "openmausbot" });
    expect((await state()).devices).toEqual([expect.objectContaining({ id: deviceId, route: "relay", routes: "any", e2eAt: expect.any(Number) })]);
    paired.session.shutdown();
  });

  it("carries a 4 MiB event, a 25 MiB upload and a Range read through the relay", async () => {
    const session = await rig.viaRelay(await state(), deviceToken);
    const stream = events(session, deviceToken);
    const big = "x".repeat(4 * 1024 * 1024 - 1024);
    const id = rig.harness.emit({ type: "shot", blob: big });
    await waitFor(() => stream.seen.find((event) => event.id === id), 15_000);
    expect((stream.seen.find((event) => event.id === id)!.data as { blob: string }).blob.length).toBe(big.length);
    const upload = randomBytes(25 * 1024 * 1024);
    const stored = await http(session, "POST", "/api/files", { token: deviceToken, body: upload, headers: { "content-type": "application/octet-stream" } });
    expect(json(stored)).toEqual({ bytes: upload.length, sha256: createHash("sha256").update(upload).digest("hex") });
    const ranged = await http(session, "GET", "/api/attachments/voice.mp3", { token: deviceToken, headers: { range: "bytes=1000-1999" } });
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(Buffer.from(Array.from({ length: 1000 }, (_, index) => attachmentByte(1000 + index))))).toBe(true);
    stream.abort();
    session.shutdown();
  }, 60_000);

  it("is reached directly on /v1/e2e, labelled Wi-Fi, and the plain listener then refuses the device", async () => {
    const session = await rig.direct(await state(), deviceToken);
    expect((await http(session, "GET", "/api/health", { token: deviceToken })).status).toBe(200);
    expect((await state()).devices[0].route).toBe("wifi");
    const plain = await fetch(`http://127.0.0.1:${rig.companionPort}/api/threads/t1/messages`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(plain.status).toBe(426);
    expect(await plain.json()).toEqual({ error: "update_app" });
    expect((await fetch(`http://127.0.0.1:${rig.companionPort}/api/health`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(200);
    session.shutdown();
  });

  it("refuses another device's token inside a session", async () => {
    const pairing = await rig.control("POST", "/pairing");
    const other = await fetch(`http://127.0.0.1:${rig.companionPort}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: pairing.token, deviceName: "Other" }),
    });
    const otherToken = ((await other.json()) as { token: string }).token;
    const session = await rig.direct(pairing, deviceToken);
    expect((await http(session, "GET", "/api/health", { token: otherToken })).status).toBe(401);
    session.shutdown();
  });

  it(`waits ${LONG ? 105 : 35} s for headers without a deadline of its own`, async () => {
    rig.harness.provideWaitMs = LONG ? 104_000 : 35_000;
    const session = await rig.viaRelay(await state(), deviceToken);
    const reply = await http(session, "POST", "/api/bots/b1/secret-cards/c1/provide", { token: deviceToken, body: "{}", headers: { "content-type": "application/json" } });
    expect(json(reply)).toEqual({ provided: true });
    session.shutdown();
    rig.harness.provideWaitMs = 0;
  }, 120_000);

  it("resumes the event stream from its cursor after the relay process dies, with no loss and no duplicates", async () => {
    const first = await rig.viaRelay(await state(), deviceToken);
    const before = events(first, deviceToken);
    const ids = [rig.harness.emit({ n: 1 }), rig.harness.emit({ n: 2 })];
    await waitFor(() => before.seen.some((event) => event.id === ids[1]));
    await relay.stop();
    expect(await first.closed).not.toBe(1000);
    const missed = rig.harness.emit({ n: 3 });
    relay = await spawnRelay(rig.signingPublicKey, relayPort);
    await waitFor(async () => (await state()).e2e.relay === "connected", 15_000);
    const second = await waitFor(async () => rig.viaRelay(await state(), deviceToken).catch(() => null), 10_000);
    const after = events(second, deviceToken, before.seen.at(-1)!.id);
    const next = rig.harness.emit({ n: 4 });
    await waitFor(() => after.seen.some((event) => event.id === next));
    const all = [...before.seen, ...after.seen].map((event) => event.id).filter((id) => id >= ids[0]);
    expect(all).toEqual([ids[0], ids[1], missed, next]);
    after.abort();
    second.shutdown();
  }, 40_000);

  it("tells a phone it is restricted to Wi-Fi and Tailscale inside its sessions, then the relay drops it (4404); direct stays", async () => {
    const current = await state();
    const relayed = await rig.viaRelay(current, deviceToken);
    const direct = await rig.direct(current, deviceToken);
    const marker = rig.harness.emit({ n: "routes" });
    const relayedEvents = events(relayed, deviceToken, marker - 1);
    const directEvents = events(direct, deviceToken, marker - 1);
    await waitFor(() => [relayedEvents, directEvents].every((stream) => stream.seen.some((event) => event.id === marker)));
    let closedAt = 0;
    const closed = relayed.closed.then((code) => ((closedAt = Date.now()), code));
    await rig.control("PUT", `/devices/${deviceId}/routes`, { routes: "local" });
    expect(await closed).toBeGreaterThan(0);
    const local = { v: 1, k: current.e2e.descriptor!.k, h: rig.hid, r: ["relay1.openmausbot.com"], routes: "local" };
    // Heard inside the relayed session itself, well before the relay closed it.
    expect(relayedEvents.pushed.map((event) => event.data)).toEqual([expect.objectContaining({ kind: "companion.endpoints", serverName: "Test Mac", e2e: local })]);
    expect(closedAt - relayedEvents.pushed[0].at).toBeGreaterThanOrEqual(200);
    await waitFor(() => directEvents.pushed.length === 1);
    expect(directEvents.pushed[0].data).toEqual(expect.objectContaining({ kind: "companion.endpoints", e2e: local }));
    const refused = await waitFor(async () => {
      const outcome = await rig.viaRelay(current, deviceToken).then((session) => (session.shutdown(), null), (error: unknown) => error);
      return outcome instanceof SessionClosed && outcome.code === 4404 ? outcome : null;
    }, 5_000);
    expect(refused.code).toBe(4404);
    expect(direct.state).toBe("open");
    const endpoints = json(await http(direct, "GET", "/api/companion/endpoints", { token: deviceToken }));
    expect(endpoints.e2e).toEqual(local);

    // Allowed again: admitted first, then told, on the session that stayed.
    await rig.control("PUT", `/devices/${deviceId}/routes`, { routes: "any" });
    await waitFor(() => directEvents.pushed.length === 2);
    expect(directEvents.pushed[1].data).toEqual(expect.objectContaining({ kind: "companion.endpoints", e2e: { v: 1, k: current.e2e.descriptor!.k, h: rig.hid, r: ["relay1.openmausbot.com"] } }));
    const back = await waitFor(() => rig.viaRelay(current, deviceToken).catch(() => null), 5_000);
    expect((await http(back, "GET", "/api/health", { token: deviceToken })).status).toBe(200);
    // The harness's own stream is untouched: no id was spent and its events still arrive.
    const after = rig.harness.emit({ n: 5 });
    await waitFor(() => directEvents.seen.some((event) => event.id === after));
    back.shutdown();
    directEvents.abort();
    relayedEvents.abort();
    direct.shutdown();
  });

  it("tells a removed phone so inside the encryption, then closes with 4001, through the relay and directly", async () => {
    const current = await state();
    const relayed = await waitFor(() => rig.viaRelay(current, deviceToken).catch(() => null), 5_000);
    const direct = await rig.direct(current, deviceToken);
    const started = Date.now();
    await rig.control("DELETE", `/devices/${deviceId}`);
    expect(await direct.closed).toBe(4001);
    await relayed.closed;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(direct.removed).toBe(true);
    // Through the relay only the authenticated GoAway counts; the close code is whatever the relay sends.
    expect(relayed.removed).toBe(true);
    await expect(rig.direct(current, deviceToken)).rejects.toEqual(new SessionClosed(4001));
  });
});
