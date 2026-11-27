import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOwnHome, oneOwner, ownServerOwner, selfHostedPersonName, type OwnServerFacts } from "./own-home.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRecord } from "./sessions.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const solo: OwnServerFacts = { managed: false, shared: false, admins: [] };
const session = (scopes: Array<"admin" | "client">, email?: string): RequestAuth => ({
  kind: "session", via: "cookie", scopes,
  session: { id: "s1", tokenHash: "0".repeat(64), label: "OpenMausBot app", scopes, createdAt: 1, lastSeenAt: 1, expiresAt: 2, ...(email ? { email } : {}) } as SessionRecord,
});

describe("a server of one person's own", () => {
  it("is one nobody else signs in to: never a Cloud, a team's or a hosted workspace, and never with members or a second admin", () => {
    expect(oneOwner(solo)).toBe(true);
    expect(oneOwner({ ...solo, admins: ["me@example.test"] })).toBe(true);
    expect(oneOwner({ ...solo, managed: true })).toBe(false);
    expect(oneOwner({ ...solo, shared: true })).toBe(false);
    expect(oneOwner({ ...solo, admins: ["me@example.test", "her@example.test"] })).toBe(false);
    expect(oneOwner({ ...solo, admins: ["@example.test"] }), "everyone at a domain").toBe(false);
  });

  it("answers its one owner's admin sign-in only: their paired devices, or their address when the list names one", () => {
    expect(ownServerOwner(solo, session(["admin", "client"]))).toBe(true);
    expect(ownServerOwner(solo, session(["client"])), "a device that may only chat").toBe(false);
    expect(ownServerOwner(solo, { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth), "a program on the server itself").toBe(false);
    const listed = { ...solo, admins: ["me@example.test"] };
    expect(ownServerOwner(listed, session(["admin"], "Me@Example.test"))).toBe(true);
    expect(ownServerOwner(listed, session(["admin"], "her@example.test"))).toBe(false);
    expect(ownServerOwner(listed, session(["admin"]))).toBe(true);
    expect(ownServerOwner({ ...solo, shared: true }, session(["admin"]))).toBe(false);
    expect(ownServerOwner({ ...solo, managed: true }, session(["admin"]))).toBe(false);
  });

  it("is that person's home once a move from them arrived, while it stays theirs alone", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-own-home-"));
    dirs.push(dataDir);
    let facts = solo;
    const home = createOwnHome({ dataDir, facts: () => facts });
    expect(home.takesMove()).toBe(true);
    expect(home.here()).toBe(false);
    writeFileSync(join(dataDir, "moved-from.json"), JSON.stringify({ computer: "Work laptop", at: 1, told: [] }));
    expect(home.here()).toBe(true);
    facts = { ...solo, shared: true };
    expect(home.here(), "others sign in now").toBe(false);
    expect(home.takesMove()).toBe(false);
  });

  it("names its one admin's address for shared computers, and is no server of one person's own once others sign in", () => {
    let facts = solo;
    const home = createOwnHome({ dataDir: tmpdir(), facts: () => facts });
    expect(home.ownServer()).toEqual({ admin: null });
    facts = { ...solo, admins: ["me@example.test"] };
    expect(home.ownServer()).toEqual({ admin: "me@example.test" });
    facts = { ...solo, admins: ["me@example.test", "her@example.test"] };
    expect(home.ownServer()).toBeNull();
    facts = { ...solo, shared: true };
    expect(home.ownServer()).toBeNull();
  });
});

describe("what a self-hosted server calls someone on their lines", () => {
  const profile = { name: "Ada Lovelace", email: "ada@example.test" };
  const signIn = (scopes: Array<"admin" | "client">, email?: string) => ({ label: "Chrome on Mac", scopes, ...(email ? { email } : {}) });

  it("is the profile's name for the profile's own address, and for the one admin by address or by their own device", () => {
    expect(selfHostedPersonName(signIn(["client"], "Ada@Example.test"), [], profile)).toBe("Ada Lovelace");
    expect(selfHostedPersonName(signIn(["admin", "client"]), [], profile)).toBe("Ada Lovelace");
    expect(selfHostedPersonName(signIn(["admin", "client"], "me@example.test"), ["me@example.test"], profile)).toBe("Ada Lovelace");
    expect(selfHostedPersonName(signIn(["admin", "client"]), ["me@example.test"], profile)).toBe("Ada Lovelace");
  });

  it("is someone else's address as a name, never the profile's", () => {
    expect(selfHostedPersonName(signIn(["client"], "grace.hopper@example.test"), [], profile)).toBe("Grace Hopper");
    expect(selfHostedPersonName(signIn(["admin", "client"], "grace@example.test"), ["me@example.test"], profile)).toBe("Grace");
  });

  it("keeps a device's label when it may be someone else's: one that may only chat, or one paired while several can pair", () => {
    expect(selfHostedPersonName(signIn(["client"]), [], profile), "a device that may only chat").toBe("Chrome on Mac");
    expect(selfHostedPersonName(signIn(["admin", "client"]), ["me@example.test", "grace@example.test"], profile)).toBe("Chrome on Mac");
    expect(selfHostedPersonName(signIn(["admin", "client"]), ["@example.test"], profile), "everyone at a domain").toBe("Chrome on Mac");
    expect(selfHostedPersonName({ label: "Nightly CI", scopes: ["admin", "client"], token: true }, [], profile), "a script token").toBe("Nightly CI");
  });

  it("falls back to the address or label while the profile has no name", () => {
    expect(selfHostedPersonName(signIn(["admin", "client"]), [], { name: " ", email: "" })).toBe("Chrome on Mac");
    expect(selfHostedPersonName(signIn(["client"], "ada@example.test"), [], { email: "ada@example.test" })).toBe("Ada");
  });
});
