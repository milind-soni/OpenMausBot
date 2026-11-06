import { mkdtempSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cloudHomeConfiguration, cloudRequestSignature, createCloudPairing } from "./cloud-home.ts";
import {
  cloudHomeChildEnvironments, edgeCertificateStorage, edgeClientAddress, edgeConfigFiles, edgeTerminatesTls, OWN_SERVER_EDGE_KEYS, trustedProxyList,
} from "./cloud-home-start.ts";
import { requestSource } from "./request-auth.ts";
import { LOCKOUT, SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTempDir(directory); });

const secret = "S".repeat(43);
const ownServer = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OMB_CLOUD_ROLE: "team", OMB_CLOUD_TEAM_ID: "team-1", OMB_CLOUD_TEAM_NAME: "Acme", OMB_CLOUD_MACHINE_ID: "box-1a2b3c",
  OMB_CLOUD_ADMIN_URL: "https://cloud.example.test", OMB_PUBLIC_URL: "https://mausbot.acme.example", OMB_CLOUD_BOOTSTRAP_SECRET: secret,
  PATH: "/usr/bin", ...extra,
});
const edgeOf = (env: NodeJS.ProcessEnv, home = "/data") => cloudHomeChildEnvironments(cloudHomeConfiguration(env)!, env, home);

it("takes the owner's proxies as addresses or ranges, and refuses anything else the edge's config would read as more", () => {
  expect(trustedProxyList(undefined)).toEqual([]);
  expect(trustedProxyList("  ")).toEqual([]);
  expect(trustedProxyList("10.0.0.5, 172.17.0.1\n192.168.0.0/16 2001:db8::1 fd00::/8 private_ranges"))
    .toEqual(["10.0.0.5/32", "172.17.0.1/32", "192.168.0.0/16", "2001:db8::1/128", "fd00::/8", "private_ranges"]);
  for (const bad of [
    "0.0.0.0/0", "::/0", "10.0.0.0/33", "fd00::/129", "10.0.0.0/", "10.0.0.0/8/8", "10.0.0.0/x", "proxy.acme.example", "10.0.0.256",
    "10.0.0.1}\nrespond 200", "{$OMB_CLOUD_BOOTSTRAP_SECRET}", "10.0.0.1;", "*",
  ]) expect(() => trustedProxyList(bad), bad).toThrow(/OMB_CLOUD_TRUSTED_PROXIES/);
  expect(() => trustedProxyList(Array.from({ length: 33 }, (_, i) => `10.0.0.${i}`).join(" "))).toThrow(/more than 32/);
});

it("trusts no client-address header on an own server by default, and only the named proxies' header when set", () => {
  expect(edgeClientAddress({})).toEqual({ OMB_CLOUD_EDGE_CLIENT_IP_HEADER: "X-Forwarded-For", OMB_CLOUD_EDGE_TRUSTED_PROXIES: "" });
  expect(edgeClientAddress({ OMB_CLOUD_TRUSTED_PROXIES: "172.17.0.1" }))
    .toEqual({ OMB_CLOUD_EDGE_CLIENT_IP_HEADER: "X-Forwarded-For", OMB_CLOUD_EDGE_TRUSTED_PROXIES: "172.17.0.1/32" });
  expect(edgeClientAddress({ OMB_CLOUD_TRUSTED_PROXIES: "10.1.2.0/24", OMB_CLOUD_CLIENT_IP_HEADER: "X-Real-IP" }))
    .toEqual({ OMB_CLOUD_EDGE_CLIENT_IP_HEADER: "X-Real-IP", OMB_CLOUD_EDGE_TRUSTED_PROXIES: "10.1.2.0/24" });
  expect(() => edgeClientAddress({ OMB_CLOUD_CLIENT_IP_HEADER: "Cf-Connecting-IP" })).toThrow(/needs OMB_CLOUD_TRUSTED_PROXIES/);
  for (const header of ["X-Forwarded-For X-Real-IP", "X-Real-IP}", "-X", "X_Real_IP", "x".repeat(65)]) {
    expect(() => edgeClientAddress({ OMB_CLOUD_TRUSTED_PROXIES: "10.0.0.1", OMB_CLOUD_CLIENT_IP_HEADER: header }), header).toThrow(/one header name/);
  }
  // The edge's own names are the launcher's to write; set from outside, they change nothing.
  expect(edgeOf(ownServer({ OMB_CLOUD_EDGE_TRUSTED_PROXIES: "0.0.0.0/0", OMB_CLOUD_EDGE_CLIENT_IP_HEADER: "X-Real-IP" })).edge)
    .toMatchObject({ OMB_CLOUD_EDGE_TRUSTED_PROXIES: "", OMB_CLOUD_EDGE_CLIENT_IP_HEADER: "X-Forwarded-For" });
  // Fly's proxy ends TLS and names the client there, so an own server's settings on Fly are a mistake that stops the start.
  for (const key of OWN_SERVER_EDGE_KEYS) {
    expect(() => edgeClientAddress({ FLY_APP_NAME: "omb-u-1a2b3c4d5e6f", [key]: "1" }), key).toThrow(new RegExp(`${key} is for a home on its own server`));
  }
});

it("serves HTTPS on the home's own domain only when asked, with the certificate on the volume", () => {
  expect(edgeTerminatesTls({})).toBe(false);
  expect(edgeTerminatesTls({ OMB_CLOUD_EDGE_TLS: "0" })).toBe(false);
  expect(edgeTerminatesTls({ OMB_CLOUD_EDGE_TLS: " 1 " })).toBe(true);
  for (const raw of ["true", "yes", "2"]) expect(() => edgeTerminatesTls({ OMB_CLOUD_EDGE_TLS: raw }), raw).toThrow(/OMB_CLOUD_EDGE_TLS must be 1/);

  const plain = edgeOf(ownServer());
  expect(plain.edgeFiles).toEqual({ config: "/app/cloud/Caddyfile", routes: "/app/cloud/edge-routes.caddy" });
  expect(plain.edge).not.toHaveProperty("OMB_CLOUD_EDGE_STORAGE");

  const tls = edgeOf(ownServer({ OMB_CLOUD_EDGE_TLS: "1" }));
  expect(tls.edgeFiles).toEqual({ config: "/app/cloud/Caddyfile.tls", routes: "/app/cloud/edge-routes.caddy" });
  expect(tls.edge.OMB_CLOUD_PUBLIC_HOST).toBe("mausbot.acme.example");
  // A new container (an update, a rollback, a restart on a new host) finds the same certificate; Let's Encrypt issues
  // one name at most 5 times a week.
  expect(tls.edge.OMB_CLOUD_EDGE_STORAGE).toBe("/data/.omb-edge/caddy");
  expect(posix.relative("/data", tls.edge.OMB_CLOUD_EDGE_STORAGE!)).not.toMatch(/^\.\.|^\//);
  expect(tls.edge.OMB_CLOUD_EDGE_STORAGE).not.toMatch(/^\/tmp\//);
  expect(edgeCertificateStorage("/srv/home")).toBe("/srv/home/.omb-edge/caddy");
  // Never in the server's data folder: a workspace backup or export must not carry the site's private key.
  expect(posix.relative(tls.server.OMB_DATA_DIR!, tls.edge.OMB_CLOUD_EDGE_STORAGE!)).toMatch(/^\.\.\//);
  expect(tls.server).not.toHaveProperty("OMB_CLOUD_EDGE_TLS");
  expect(tls.server).not.toHaveProperty("OMB_CLOUD_EDGE_STORAGE");

  expect(edgeConfigFiles({ OMB_CLOUD_EDGE_CONFIG: "/etc/omb-edge/Caddyfile", OMB_CLOUD_EDGE_TLS: "1" }))
    .toEqual({ config: "/etc/omb-edge/Caddyfile", routes: "/etc/omb-edge/edge-routes.caddy" });
  expect(() => edgeOf(ownServer({ OMB_CLOUD_EDGE_TLS: "on" }))).toThrow(/OMB_CLOUD_EDGE_TLS/);
});

/** A request as the server receives it: the edge on loopback, with X-Forwarded-For set to the address it trusts. */
const fromEdge = (client: string) =>
  // SAFETY: only headers and the socket peer are read
  ({ headers: { "x-forwarded-for": client, "x-forwarded-proto": "https" }, method: "POST", socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
const direct = (peer: string, headers: Record<string, string>) =>
  // SAFETY: only headers and the socket peer are read
  ({ headers, method: "POST", socket: { remoteAddress: peer } }) as unknown as IncomingMessage;

it("counts each client behind the edge on its own: one stranger's wrong codes lock out neither a member nor the Admin", () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-cloud-address-"));
  directories.push(directory);
  let now = 1_800_000_000_000;
  const sessions = new SessionRegistry({ file: join(directory, "sessions.json"), now: () => now });
  const team = { id: "team-1", name: "Acme" };
  const pairing = createCloudPairing({ secret, sessions, team, now: () => now });
  const adminPairs = (source: string) => {
    const body = Buffer.from(JSON.stringify({ label: "Phone", team: { id: team.id }, member: { email: "ana@acme.example", role: "member" } }));
    const timestamp = String(Math.floor(now / 1000)), nonce = `nonce-${now}-${source}`.replace(/[^\w-]/g, "-");
    const signature = `v1=${cloudRequestSignature(secret, timestamp, nonce, "POST", "/api/cloud/pairing", body)}`;
    return pairing.handle({ timestamp, nonce, signature, body, source });
  };

  const stranger = requestSource(fromEdge("203.0.113.7"));
  for (let i = 0; i < LOCKOUT.failures; i++) expect(sessions.exchange({ code: "AAAAAAAAAAAA", label: "", source: stranger }).ok).toBe(false);
  expect(sessions.exchange({ code: "AAAAAAAAAAAA", label: "", source: stranger })).toMatchObject({ ok: false, status: 429 });

  // The Admin's request reaches the edge through the agent, whose address the edge names like any other.
  const admin = adminPairs(requestSource(fromEdge("172.17.0.1")));
  expect(admin.status).toBe(200);
  const member = requestSource(fromEdge("198.51.100.20"));
  expect(sessions.exchange({ code: "AAAAAAAAAAAA", label: "", source: member })).toMatchObject({ ok: false, status: 401 });
  expect(sessions.exchange({ code: String(admin.body.code), label: "Phone", source: member }).ok).toBe(true);

  // The edge is the only loopback peer: a forwarded header from any other peer names nobody, so a stranger who forges
  // a new address on each try is still one source.
  const spoofed = new Set(Array.from({ length: 5 }, (_, i) => requestSource(direct("203.0.113.9", { "x-forwarded-for": `10.9.9.${i}`, "cf-connecting-ip": `10.8.8.${i}` }))));
  expect([...spoofed]).toEqual(["203.0.113.9"]);
  // Only the edge's own hop counts: a client's forged X-Forwarded-For comes before it.
  expect(requestSource(fromEdge("10.9.9.9, 203.0.113.7"))).toBe(stranger);

  now += LOCKOUT.lockMs + 1;
  expect(adminPairs(stranger).status).toBe(200);
});
