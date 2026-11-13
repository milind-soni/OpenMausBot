import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lendingPersonKey, OWN_SERVER_LENDER, personKey } from "./person-key.ts";
import type { LoopbackTurnProvenance } from "./direct-send.ts";
import { loopbackSharedComputerPrincipal, loopbackTurnProvenance, requestSharedComputerPrincipal, requestTurnProvenance, SharedComputerTurnAuthorization } from "./loopback-turn-provenance.ts";
import { loopbackCredentialId, resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { SharedComputers } from "./shared-computers.ts";

const own = { admin: null };
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const resolve = (headers: Record<string, string>, sessions = { authenticate: () => null, leftTeam: () => false } as unknown as SessionRegistry) => resolveRequestAuth(
  { headers, method: "POST" } as unknown as IncomingMessage,
  { sessions, cookieName: "omb_session", streamPath: "/api/events", url: new URL("/api/bots/b/messages", "http://localhost"), loopbackMutationToken: "desktop-proof", companionMutationToken: "sidecar-proof" },
).auth;

describe("loopback shared-computer request provenance", () => {
  it.each([
    ["desktop owner", { host: "127.0.0.1:8799", "x-openmausbot-desktop-owner": "desktop-proof" }],
    ["paired companion", { host: "127.0.0.1:8799", "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "paired-device", "x-openmausbot-companion-auth": "sidecar-proof" }],
  ])("reaches the owner's actual inventory through %s authentication", (_name, headers) => {
    const auth = resolve(headers);
    expect(auth).not.toBeNull();
    const proof = loopbackTurnProvenance(auth!, own);
    const principal = loopbackSharedComputerPrincipal(proof, own, () => false, (candidate) => candidate.credentialId === loopbackCredentialId(candidate.kind === "desktop-owner" ? "desktop-proof" : "sidecar-proof"));
    expect(principal).toBe(OWN_SERVER_LENDER);

    const computers = new SharedComputers((session) => session === "registered-lender");
    const id = "4f3c14c1-1c7d-4a80-b908-fb559a6c239d";
    computers.register({ id, name: "Granted computer", environmentId: "c036782a-7b14-4241-a22f-0141d6efda47", folders: [], terminal: false, computer: true },
      { session: "registered-lender", person: OWN_SERVER_LENDER }, "a".repeat(64));
    expect(computers.list(principal).map((computer) => computer.id)).toEqual([id]);
    computers.close();
  });

  it("does not turn generic, invalid, or shared-home loopback into the owner", () => {
    const generic = resolve({ host: "127.0.0.1:8799" });
    const invalidDesktop = resolve({ host: "127.0.0.1:8799", "x-openmausbot-desktop-owner": "wrong" });
    const invalidCompanion = resolve({ host: "127.0.0.1:8799", "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "paired-device", "x-openmausbot-companion-auth": "wrong" });
    for (const auth of [generic, invalidDesktop, invalidCompanion]) {
      expect(auth ? loopbackTurnProvenance(auth, own) : undefined).toBeUndefined();
      expect(loopbackSharedComputerPrincipal(undefined, own)).toBeNull();
    }
    expect(loopbackSharedComputerPrincipal({ kind: "desktop-owner", credentialId: "unknown" }, own, () => false, () => false)).toBeNull();
    expect(loopbackSharedComputerPrincipal({ kind: "companion", deviceId: "paired-device", credentialId: "unknown" }, own, (id) => id === "paired-device", () => false)).toBeNull();
  });

  it("invalidates loopback turn provenance when its authenticated credential rotates", () => {
    const auth = resolve({ host: "127.0.0.1:8799", "x-openmausbot-desktop-owner": "desktop-proof" });
    const proof = loopbackTurnProvenance(auth!, own)!;
    expect(loopbackSharedComputerPrincipal(proof, own, () => false, (candidate) => candidate.credentialId === loopbackCredentialId("desktop-proof"))).toBe(OWN_SERVER_LENDER);
    expect(loopbackSharedComputerPrincipal(proof, own, () => false, (candidate) => candidate.credentialId === loopbackCredentialId("rotated-token"))).toBeNull();
  });

  it("keeps a nameless authenticated session's verified key and fails closed when revoked", () => {
    const session = { id: "paired-owner-session", label: "", scopes: ["admin", "client"] as ("admin" | "client")[], createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const proof = { kind: "session" as const, sessionId: session.id, person: personKey(session) };
    expect(session.label).toBe("");
    expect(lendingPersonKey(session, own)).toBe(OWN_SERVER_LENDER);
    expect(requestSharedComputerPrincipal(proof, own, [session], (id) => id === session.id)).toBe(OWN_SERVER_LENDER);
    expect(requestSharedComputerPrincipal(proof, own, [session], () => false)).toBeNull();
    expect(requestSharedComputerPrincipal(proof, own, [session], () => true)).toBe(OWN_SERVER_LENDER);
  });

  it("carries a real authenticated session identity separately from its display label", () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-turn-provenance-")); directories.push(directory);
    const sessions = new SessionRegistry({ file: join(directory, "sessions.json") });
    const issued = sessions.issue({ label: "", scopes: ["admin", "client"] });
    const auth = resolve({ authorization: `Bearer ${issued.token}` }, sessions);
    expect(auth?.kind).toBe("session");
    if (!auth || auth.kind !== "session") throw new Error("expected verified session auth");
    const proof = requestTurnProvenance(auth, own, (verified) => personKey(verified.session));
    const principal = new SharedComputerTurnAuthorization().principal({ requestProvenance: proof, messageId: "server-message", generations: new Set(["turn-1"]) }, "turn-1", own, sessions.list(), (id) => sessions.isLive(id), []);
    expect(auth.session.label).toBe("Unnamed device");
    expect(proof?.kind === "session" && proof.person).not.toBe(auth.session.label);
    expect(principal).toBe(OWN_SERVER_LENDER);
    sessions.revoke(auth.session.id);
    expect(new SharedComputerTurnAuthorization().principal({ requestProvenance: proof, messageId: "server-message", generations: new Set(["turn-1"]) }, "turn-1", own, sessions.list(), (id) => sessions.isLive(id), [])).toBeNull();
    sessions.close();
  });

  it("does not let replaced generations or revoked companions retain inventory access", () => {
    const authz = new SharedComputerTurnAuthorization();
    const proof = { kind: "companion" as const, deviceId: "paired-device", credentialId: "rotated-proof" };
    const request = { requestProvenance: proof, messageId: "request-message", generations: new Set(["new-generation"]) };
    const credentialIsCurrent = (candidate: LoopbackTurnProvenance) => candidate.kind === "companion" && candidate.credentialId === proof.credentialId;
    expect(authz.principal(request, "old-generation", own, [], () => false, [], credentialIsCurrent)).toBeNull();
    expect(authz.principal(request, "new-generation", own, [], () => false, [], credentialIsCurrent)).toBe(OWN_SERVER_LENDER);
    authz.revokeCompanion("paired-device", [request]);
    expect(request).toHaveProperty("stopped", true);
    expect(authz.principal(request, "new-generation", own, [], () => false, [], credentialIsCurrent)).toBeNull();
  });
});
