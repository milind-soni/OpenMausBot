// The server's side of MausBot Relay against the fake relay, driven by the reference phone: the server's own sessions
// are the phones, and every relayed request reaches the handler as a remote one.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { admission, admissionHash, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../companion/src/e2e/credentials.ts";
import { TRANSPORT_RELAY } from "../companion/src/e2e/noise.ts";
import { dial } from "../companion/src/e2e/phone.ts";
import { SessionClosed, type E2ESession } from "../companion/src/e2e/session.ts";
import { startFakeRelay, type FakeRelay } from "../companion/test/e2e/fake-relay.ts";
import { http, json, waitFor } from "../companion/test/e2e/rig.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { MAX_RELAY_PHONES, MAX_SESSIONS_PER_PHONE, PHONE_RELAY_KEY_FILE, PHONE_RELAY_PHONES_FILE, startPhoneRelay, tunnelHolder, type PhoneRelay, type PhoneRelayOptions } from "./phone-relay.ts";
import { requestSource, resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";

const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);
const NODE = "relay1.openmausbot.com";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function grantFor(hostId: Buffer) {
  const iat = Math.floor(Date.now() / 1000);
  const token = mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey);
  return { token, hostId: b64u(hostId), nodes: [NODE], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000 };
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** The parts of the server's handler a phone meets: `/api/pair` as the server answers it, and the real request gate. */
function serverHandler(sessions: SessionRegistry, relay: () => PhoneRelay | null) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://server");
    const send = (status: number, payload: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (req.method === "POST" && url.pathname === "/api/pair") {
      const input = await body(req);
      const presented = input.credential ?? input.code ?? "";
      const refusal = relay()?.pairingRefusal(req, presented);
      if (refusal) return send(400, { error: refusal });
      const paired = sessions.exchange({ code: presented, label: input.deviceName ?? "", source: requestSource(req) });
      if (!paired.ok) return send(paired.status, { error: paired.error });
      return send(200, { token: paired.token, device: { id: paired.session.id }, serverName: "VPS", ...relay()?.pairedOver(req) });
    }
    if (url.pathname === "/api/test-stream") {
      // Like the event stream: answers for as long as the phone listens, and never reads the request.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tick = setInterval(() => res.write("data: tick\n\n"), 100);
      res.once("close", () => clearInterval(tick));
      return;
    }
    const gate = resolveRequestAuth(req, { sessions, cookieName: "omb_session", streamPath: "/api/events", url });
    if (url.pathname === "/api/health" && !gate.auth) return send(200, { app: "openmausbot" });
    if (!gate.auth) return send(gate.status, { error: gate.error });
    return send(200, { kind: gate.auth.kind, id: gate.auth.kind === "session" ? gate.auth.session.id : null, source: requestSource(req), host: req.headers.host, via: gate.auth.kind === "session" ? gate.auth.via : null });
  };
}

interface Server {
  dir: string;
  relay: FakeRelay;
  sessions: SessionRegistry;
  phoneRelay: PhoneRelay;
  hostId: Buffer;
  logs: string[];
}

async function startServer(input: Partial<PhoneRelayOptions> & { dir?: string; relay?: FakeRelay } = {}): Promise<Server> {
  const { dir: givenDir, relay: givenRelay, ...overrides } = input;
  const dir = givenDir ?? mkdtempSync(join(tmpdir(), "omb-phone-relay-"));
  if (!givenDir) cleanup.push(() => removeTempDir(dir));
  const relay = givenRelay ?? await startFakeRelay({ keys });
  if (!givenRelay) cleanup.push(() => relay.close());
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  cleanup.push(() => sessions.close());
  const hostId = randomBytes(16);
  const logs: string[] = [];
  let phoneRelay: PhoneRelay | null = null;
  phoneRelay = startPhoneRelay({
    env: { OMB_PHONE_RELAY: "1", OMB_PHONE_RELAY_URL: relay.url },
    dataDir: dir,
    sessions,
    handle: serverHandler(sessions, () => phoneRelay),
    serverName: () => "VPS",
    publicOrigin: () => null,
    version: "0.1.152",
    refusal: null,
    fetchGrant: async () => grantFor(hostId),
    log: (line) => logs.push(line),
    ...overrides,
  });
  if (!phoneRelay) throw new Error(`the relay did not start: ${logs.join("; ")}`);
  const started = phoneRelay;
  cleanup.push(() => started.stop());
  return { dir, relay, sessions, phoneRelay: started, hostId, logs };
}

function descriptorOf(link: string): { v: number; k: string; h?: string; r?: string[] } {
  const value = new URL(link).searchParams.get("e2e");
  if (!value) throw new Error("no e2e descriptor in the link");
  return JSON.parse(fromB64u(value)!.toString("utf8"));
}

function viaRelay(server: Server, k: Buffer, token: string): Promise<E2ESession<never>> {
  return dial({
    url: `${server.relay.url}/v1/phone`,
    transportByte: TRANSPORT_RELAY,
    remoteStatic: k,
    psk: psk(credentialHash(token), keyId(k)),
    app: "test/1",
    relay: { hostId: server.hostId, adm: admission(credentialHash(token), server.hostId) },
  });
}

const connected = (server: Server) => waitFor(() => server.phoneRelay.status().relay === "connected", 5_000);

async function pairPhone(server: Server): Promise<{ token: string; id: string; k: Buffer; session: E2ESession<never> }> {
  const opened = server.sessions.openPairing({ scopes: ["client"] });
  const link = server.phoneRelay.invite(opened.credential, "VPS", null);
  if (!link) throw new Error("no relay invite");
  const k = fromB64u(descriptorOf(link).k)!;
  const session = await waitFor(() => viaRelay(server, k, opened.credential).catch(() => null), 6_000);
  const paired = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential, deviceName: "Pixel" }), headers: { "content-type": "application/json" } });
  if (paired.status !== 200) throw new Error(`pairing failed: ${paired.status} ${paired.body}`);
  const reply = json(paired) as { token: string; device: { id: string } };
  return { token: reply.token, id: reply.device.id, k, session };
}

describe("phones through MausBot Relay on a server", () => {
  it("stays off unless asked for, and never runs where the desktop's companion or a Cloud carries phones", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-phone-relay-off-"));
    cleanup.push(() => removeTempDir(dir));
    const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
    cleanup.push(() => sessions.close());
    const logs: string[] = [];
    const base = { dataDir: dir, sessions, handle: () => {}, serverName: () => "VPS", publicOrigin: () => null, version: "0.1.152", log: (line: string) => logs.push(line) };
    expect(startPhoneRelay({ ...base, env: {}, refusal: null })).toBeNull();
    expect(startPhoneRelay({ ...base, env: { OMB_PHONE_RELAY: "true" }, refusal: null })).toBeNull();
    expect(startPhoneRelay({ ...base, env: { OMB_PHONE_RELAY: "1" }, refusal: "a MausBot Cloud home" })).toBeNull();
    expect(logs).toEqual(["phone relay: off on a MausBot Cloud home"]);
    expect(() => statSync(join(dir, PHONE_RELAY_KEY_FILE))).toThrow();
  });

  it("pairs a phone by its QR through the relay, and the phone then signs in as its own session, never as this machine", async () => {
    const server = await startServer();
    await connected(server);
    expect(server.logs).toContain(`phone relay: connected via ${NODE}`);
    const opened = server.sessions.openPairing({ scopes: ["client"] });
    const link = server.phoneRelay.invite(opened.credential, "VPS", null)!;
    expect(link).toMatch(/^openmausbot:\/\/pair\?address=relay-only\.invalid%3A443&token=omb_pair_/);
    const descriptor = descriptorOf(link);
    expect(descriptor).toEqual({ v: 1, k: expect.any(String), h: b64u(server.hostId), r: [NODE] });
    const k = fromB64u(descriptor.k)!;
    // The open window's admission value reaches the relay, and nothing else does.
    await waitFor(() => server.relay.admitted(b64u(server.hostId)).has(admissionHash(admission(credentialHash(opened.credential), server.hostId))));

    const session = await waitFor(() => viaRelay(server, k, opened.credential).catch(() => null), 6_000);
    expect(json(await http(session, "GET", "/api/health"))).toEqual({ app: "openmausbot" });
    expect(await http(session, "GET", "/api/auth/session").then((reply) => [reply.status, json(reply).error])).toEqual([401, "pair this phone first"]);

    const paired = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential, deviceName: "Pixel" }), headers: { "content-type": "application/json" } });
    expect(paired.status).toBe(200);
    const reply = json(paired) as { token: string; device: { id: string }; e2e: unknown };
    expect(reply.e2e).toEqual(descriptor);
    expect(server.phoneRelay.status()).toMatchObject({ relay: "connected", grant: "ok", phones: 1, maxPhones: MAX_RELAY_PHONES });
    expect(JSON.parse(readFileSync(join(server.dir, PHONE_RELAY_PHONES_FILE), "utf8"))).toEqual({ v: 1, phones: [reply.device.id] });

    // The same session now speaks for the new phone, with its own session.
    expect(json(await http(session, "GET", "/api/auth/session", { token: reply.token }))).toEqual({ kind: "session", id: reply.device.id, source: `relay-${reply.device.id}`, host: "phone-relay.invalid", via: "bearer" });
    // Whatever the phone writes, a relayed request is never this machine's.
    const spoofed = await http(session, "GET", "/api/auth/session", { headers: { host: "127.0.0.1:8799", "x-openmausbot-cli-owner": "x", "x-forwarded-for": "127.0.0.1", cookie: "omb_session=x" } });
    expect(spoofed.status).toBe(403);
    expect(json(spoofed).error).toMatch(/proxy/);
    // A token inside the session must be the one whose key opened it.
    const other = server.sessions.issue({ label: "Laptop", scopes: ["admin", "client"] });
    expect(await http(session, "GET", "/api/auth/session", { token: other.token }).then((r) => [r.status, json(r).error])).toEqual([401, "this connection belongs to another device"]);
    expect(json(await http(session, "GET", "/api/companion/endpoints", { token: reply.token }))).toEqual({ serverName: "VPS", endpoints: [], e2e: descriptor });
    session.shutdown();

    // The window is spent; the phone's own key opens the next session, and a session the relay never admitted cannot.
    const again = await waitFor(() => viaRelay(server, k, reply.token).catch(() => null), 6_000);
    expect(json(await http(again, "GET", "/api/auth/session", { token: reply.token })).id).toBe(reply.device.id);
    again.shutdown();
    await expect(viaRelay(server, k, other.token)).rejects.toEqual(new SessionClosed(4404));
    // The pairing session's admission lasts only as long as that session.
    expect(await waitFor(async () => {
      const outcome = await viaRelay(server, k, opened.credential).then((check) => (check.shutdown(), null), (error: unknown) => error);
      return outcome instanceof SessionClosed && outcome.code === 4404 ? outcome : null;
    }, 6_000)).toEqual(new SessionClosed(4404));
  });

  it("tells a removed phone so inside the encryption, then the relay admits it no more", async () => {
    const server = await startServer();
    await connected(server);
    const phone = await pairPhone(server);
    const live = await waitFor(() => viaRelay(server, phone.k, phone.token).catch(() => null), 6_000);
    expect(server.sessions.revoke(phone.id)).toBe(true);
    await live.closed;
    expect(live.removed).toBe(true);
    expect(server.phoneRelay.status().phones).toBe(0);
    expect(JSON.parse(readFileSync(join(server.dir, PHONE_RELAY_PHONES_FILE), "utf8")).phones).toEqual([]);
    const refused = await waitFor(async () => {
      const outcome = await viaRelay(server, phone.k, phone.token).then((session) => (session.shutdown(), null), (error: unknown) => error);
      return outcome instanceof SessionClosed && outcome.code === 4404 ? outcome : null;
    }, 6_000);
    expect(refused.code).toBe(4404);
  });

  it(`refuses a phone past the ${MAX_RELAY_PHONES} the relay admits for one server`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-phone-relay-full-"));
    cleanup.push(() => removeTempDir(dir));
    const seed = new SessionRegistry({ file: join(dir, "sessions.json") });
    const ids = Array.from({ length: MAX_RELAY_PHONES }, (_, n) => seed.issue({ label: `Phone ${n}`, scopes: ["client"] }).session.id);
    seed.close();
    writeFileSync(join(dir, PHONE_RELAY_PHONES_FILE), JSON.stringify({ v: 1, phones: [...ids, "a-session-long-gone"] }));
    const server = await startServer({ dir });
    await connected(server);
    expect(server.phoneRelay.status().phones).toBe(MAX_RELAY_PHONES);
    expect(JSON.parse(readFileSync(join(dir, PHONE_RELAY_PHONES_FILE), "utf8")).phones).toEqual(ids);
    const opened = server.sessions.openPairing({ scopes: ["client"] });
    const k = fromB64u(descriptorOf(server.phoneRelay.invite(opened.credential, "VPS", null)!).k)!;
    const session = await waitFor(() => viaRelay(server, k, opened.credential).catch(() => null), 6_000);
    const refused = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential }), headers: { "content-type": "application/json" } });
    expect(refused.status).toBe(409);
    expect(server.sessions.openPairings()).toHaveLength(1);
    session.shutdown();
  });

  it("keeps its connection key, owner-only, across restarts, and never replaces one it cannot read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-phone-relay-key-"));
    cleanup.push(() => removeTempDir(dir));
    const relay = await startFakeRelay({ keys });
    cleanup.push(() => relay.close());
    const first = await startServer({ dir, relay });
    await connected(first);
    const key = (server: Server) => descriptorOf(server.phoneRelay.invite(server.sessions.openPairing().credential, "VPS", null)!).k;
    const k = key(first);
    if (process.platform !== "win32") expect(statSync(join(dir, PHONE_RELAY_KEY_FILE)).mode & 0o777).toBe(0o600);
    first.phoneRelay.stop();
    first.sessions.close();
    const second = await startServer({ dir, relay });
    await connected(second);
    expect(key(second)).toBe(k);
    second.phoneRelay.stop();
    second.sessions.close();

    writeFileSync(join(dir, PHONE_RELAY_KEY_FILE), "{\"v\":1}\n");
    const logs: string[] = [];
    const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
    cleanup.push(() => sessions.close());
    expect(startPhoneRelay({ env: { OMB_PHONE_RELAY: "1" }, dataDir: dir, sessions, handle: () => {}, serverName: () => "VPS", publicOrigin: () => null, version: "0.1.152", refusal: null, log: (line) => logs.push(line) })).toBeNull();
    expect(logs[0]).toMatch(/^phone relay: off: .*is not a connection key/);
    expect(readFileSync(join(dir, PHONE_RELAY_KEY_FILE), "utf8")).toBe("{\"v\":1}\n");
  });

  it("says why phones can't pair yet, and makes no relay link until it can", async () => {
    const signedOut = await startServer({ fetchGrant: async () => Promise.reject(Object.assign(new Error("signed out"), { code: "signed_out" })) });
    await waitFor(() => signedOut.phoneRelay.status().grant === "signed-out");
    expect(signedOut.phoneRelay.status()).toMatchObject({ relay: "off", grant: "signed-out" });
    expect(signedOut.phoneRelay.invite(signedOut.sessions.openPairing().credential, "VPS", null)).toBeNull();

    const unavailable = await startServer({ fetchGrant: async () => Promise.reject(Object.assign(new Error("relay_unavailable"), { code: "relay_unavailable", status: 503 })) });
    await waitFor(() => unavailable.phoneRelay.status().grant === "unavailable");
    expect(unavailable.phoneRelay.status().relay).toBe("off");

    // The relay itself unreachable: it keeps dialling, and a link still works the moment it connects.
    const gone = await startFakeRelay({ keys });
    await gone.close();
    const unreachable = await startServer({ relay: gone, env: { OMB_PHONE_RELAY: "1", OMB_PHONE_RELAY_URL: gone.url } });
    await waitFor(() => unreachable.phoneRelay.status().grant === "ok");
    expect(unreachable.phoneRelay.status().relay).toBe("connecting");
  });

  it("names the server's public HTTPS address for a phone without the encrypted connection", async () => {
    const server = await startServer();
    await connected(server);
    const link = new URL(server.phoneRelay.invite(server.sessions.openPairing().credential, "VPS", "https://maus.example.com")!);
    expect(link.searchParams.get("address")).toBe("maus.example.com:443");
    expect(JSON.parse(fromB64u(link.searchParams.get("endpoints")!)!.toString("utf8"))).toEqual([{ url: "https://maus.example.com", kind: "hosted", priority: 0 }]);
    expect(new URL(server.phoneRelay.invite(server.sessions.openPairing().credential, "VPS", "http://localhost:8080")!).searchParams.get("address")).toBe("relay-only.invalid:443");
  });

  it("never asks for a relay token on a machine that holds or needs a tunnel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-phone-relay-tunnel-"));
    cleanup.push(() => removeTempDir(dir));
    const account = join(dir, "tunnel-account.json");
    expect(tunnelHolder({}, dir)).toBeNull();
    writeFileSync(account, JSON.stringify({ companionInstallationCredential: "omb_install_x" }));
    expect(tunnelHolder({}, dir)).toBeNull();
    expect(tunnelHolder({ OMB_SERVES_TUNNEL: "1", OMB_TUNNEL_SOCKET: join(dir, "t.sock") }, dir)).toBe("this server runs with --tunnel");
    // Docker's Caddy reaches the server over a socket too: that is no tunnel.
    expect(tunnelHolder({ OMB_TUNNEL_SOCKET: "/run/openmausbot/http.sock" }, dir)).toBeNull();
    expect(tunnelHolder({ OMB_INSTALLATION_CREDENTIAL: "omb_install_y" }, dir)).toMatch(/^OMB_INSTALLATION_CREDENTIAL is set/);
    writeFileSync(account, JSON.stringify({ companionInstallationCredential: "omb_install_x", managedCompanionEndpointUrl: "https://c-0123456789abcdef0123456789abcdef.openmausbot.com" }));
    expect(tunnelHolder({}, dir)).toMatch(/holds a tunnel address/);
    writeFileSync(account, "not json");
    expect(tunnelHolder({}, dir)).toMatch(/could not be read/);

    // `serve --tunnel` with OMB_PHONE_RELAY=1 in the environment, and a fleet container: off, and saying why.
    writeFileSync(account, JSON.stringify({ companionInstallationCredential: "omb_install_x" }));
    for (const env of [{ OMB_PHONE_RELAY: "1", OMB_SERVES_TUNNEL: "1", OMB_TUNNEL_SOCKET: join(dir, "t.sock") }, { OMB_PHONE_RELAY: "1", OMB_INSTALLATION_CREDENTIAL: "omb_install_y" }]) {
      let asked = 0;
      const logs: string[] = [];
      const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
      cleanup.push(() => sessions.close());
      const relay = startPhoneRelay({ env, dataDir: dir, sessions, handle: () => {}, serverName: () => "VPS", publicOrigin: () => null, version: "0.1.152", refusal: null, fetchGrant: async () => (asked += 1, {}), log: (line) => logs.push(line) })!;
      expect(relay.status()).toMatchObject({ relay: "off", grant: "tunnel", reason: expect.any(String) });
      expect(relay.invite(sessions.openPairing().credential, "VPS", null)).toBeNull();
      expect(logs[0]).toMatch(/^phone relay: off: .*login --relay/);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(asked).toBe(0);
      expect(() => statSync(join(dir, PHONE_RELAY_KEY_FILE))).toThrow();
      sessions.close();
    }
  });

  it("pairs only with the QR's credential: a typed code and the browser's pairing route are refused", async () => {
    const server = await startServer();
    await connected(server);
    const opened = server.sessions.openPairing({ scopes: ["client"] });
    const k = fromB64u(descriptorOf(server.phoneRelay.invite(opened.credential, "VPS", null)!).k)!;
    const session = await waitFor(() => viaRelay(server, k, opened.credential).catch(() => null), 6_000);
    const asJson = { "content-type": "application/json" };
    const code = await http(session, "POST", "/api/pair", { body: JSON.stringify({ code: opened.code }), headers: asJson });
    expect([code.status, json(code).error]).toEqual([400, "pair a phone with its QR code"]);
    expect((await http(session, "POST", "/api/auth/pair", { body: JSON.stringify({ code: opened.code }), headers: asJson })).status).toBe(404);
    expect(server.sessions.openPairings()).toHaveLength(1);
    expect((await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential }), headers: asJson })).status).toBe(200);
  });

  it("keeps one phone's wrong credentials from locking pairing for everyone, and still locks out a guesser", async () => {
    const server = await startServer();
    await connected(server);
    const phone = await pairPhone(server);
    phone.session.shutdown();
    const wrong = () => JSON.stringify({ credential: `omb_pair_${randomBytes(32).toString("base64url")}` });
    const asJson = { "content-type": "application/json" };
    const paired = await waitFor(() => viaRelay(server, phone.k, phone.token).catch(() => null), 6_000);
    const statuses = [];
    for (let n = 0; n < 6; n += 1) statuses.push((await http(paired, "POST", "/api/pair", { token: phone.token, body: wrong(), headers: asJson })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Another phone pairs at once.
    const second = server.sessions.openPairing({ scopes: ["client"] });
    server.phoneRelay.invite(second.credential, "VPS", null);
    const other = await waitFor(() => viaRelay(server, phone.k, second.credential).catch(() => null), 6_000);
    expect((await http(other, "POST", "/api/pair", { body: JSON.stringify({ credential: second.credential }), headers: asJson })).status).toBe(200);
    // Whoever holds a pairing window's QR and guesses is locked out on that window, in every session it opens.
    const third = server.sessions.openPairing({ scopes: ["client"] });
    server.phoneRelay.invite(third.credential, "VPS", null);
    const guesser = await waitFor(() => viaRelay(server, phone.k, third.credential).catch(() => null), 6_000);
    for (let n = 0; n < 5; n += 1) await http(guesser, "POST", "/api/pair", { body: wrong(), headers: asJson });
    guesser.shutdown();
    const again = await waitFor(() => viaRelay(server, phone.k, third.credential).catch(() => null), 6_000);
    expect((await http(again, "POST", "/api/pair", { body: JSON.stringify({ credential: third.credential }), headers: asJson })).status).toBe(429);
  });

  it(`holds at most ${MAX_SESSIONS_PER_PHONE} live sessions per phone, closing its oldest`, async () => {
    const server = await startServer();
    await connected(server);
    const phone = await pairPhone(server);
    phone.session.shutdown();
    const sessions: E2ESession<never>[] = [];
    for (let n = 0; n <= MAX_SESSIONS_PER_PHONE; n += 1) sessions.push(await waitFor(() => viaRelay(server, phone.k, phone.token).catch(() => null), 6_000));
    await sessions[0].closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessions.slice(1).map((session) => session.state)).toEqual(Array(MAX_SESSIONS_PER_PHONE).fill("open"));
    expect((await http(sessions.at(-1)!, "GET", "/api/auth/session", { token: phone.token })).status).toBe(200);
  });

  it("ends a stream that stalls in its request headers or body", async () => {
    const server = await startServer({ streamDeadlines: { headersMs: 300, requestMs: 600 } });
    await connected(server);
    const phone = await pairPhone(server);
    const ended = (stream: ReturnType<E2ESession<never>["openStream"]>) => new Promise<number>((resolve) => {
      const started = Date.now();
      stream.on("data", () => {});
      stream.on("error", () => {});
      stream.once("end", () => resolve(Date.now() - started));
    });
    const headers = phone.session.openStream();
    const headersEnded = ended(headers);
    headers.write("GET /api/health HTTP/1.1\r\nHost: phone\r\n");
    expect(await headersEnded).toBeGreaterThanOrEqual(250);
    const body = phone.session.openStream();
    const bodyEnded = ended(body);
    body.write(`POST /api/pair HTTP/1.1\r\nHost: phone\r\nAuthorization: Bearer ${phone.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a"`);
    expect(await bodyEnded).toBeGreaterThanOrEqual(550);
    expect(phone.session.state).toBe("open");

    // A long answer to a request that was complete is never cut: an event stream lives far past the body deadline.
    const listening = phone.session.openStream();
    let ticks = 0;
    let gone = false;
    listening.on("data", (chunk: Buffer) => (ticks += chunk.toString().split("data: tick").length - 1));
    listening.on("error", () => {});
    listening.once("end", () => (gone = true));
    listening.write("GET /api/test-stream HTTP/1.1\r\nHost: phone\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(gone).toBe(false);
    const before = ticks;
    await waitFor(() => ticks > before, 1_000);
    expect(ticks).toBeGreaterThan(10);
    listening.destroy();
    expect((await http(phone.session, "GET", "/api/health")).status).toBe(200);
  });

  it("accepts a stream ticket only from the phone it belongs to", async () => {
    const server = await startServer();
    await connected(server);
    const phone = await pairPhone(server);
    const other = server.sessions.issue({ label: "Laptop", scopes: ["admin", "client"] });
    const theirs = server.sessions.issueStreamTicket(other.session.id).ticket;
    const refused = await http(phone.session, "GET", `/api/events?ticket=${theirs}`);
    expect([refused.status, json(refused).error]).toEqual([401, "this connection belongs to another device"]);
    expect(server.sessions.ticketOwner(theirs)).toBe(other.session.id);
    const own = server.sessions.issueStreamTicket(phone.id).ticket;
    expect(json(await http(phone.session, "GET", `/api/events?ticket=${own}`))).toMatchObject({ kind: "session", id: phone.id, via: "ticket" });
  });

  it("reports a grant only once it is valid, and keeps one it holds through a passing failure", async () => {
    const invalid = await startServer({ fetchGrant: async () => ({ token: "not.a-grant" }) });
    await waitFor(() => invalid.phoneRelay.status().grant === "failed");
    expect(invalid.phoneRelay.status().relay).toBe("off");

    // A token the relay refuses (4401) makes the server ask again; that request fails, and the grant it holds stands.
    const stranger = generateKeyPairSync("ed25519").privateKey;
    let asked = 0;
    const holding = await startServer({
      fetchGrant: async () => {
        asked += 1;
        if (asked > 1) throw Object.assign(new Error("fetch failed"), { code: "network" });
        const iat = Math.floor(Date.now() / 1000);
        const token = mintRelayToken({ v: 1, kid: "k1", hid: b64u(randomBytes(16)), iid: "test-install", iat, exp: iat + 43_200 }, stranger);
        return { token, hostId: b64u(randomBytes(16)), nodes: [NODE], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000 };
      },
    });
    await waitFor(() => asked >= 2, 6_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(holding.phoneRelay.status()).toMatchObject({ grant: "ok", relay: "connecting" });
  });
});
