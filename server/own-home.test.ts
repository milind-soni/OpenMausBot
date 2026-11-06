import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOwnHome, oneOwner, ownServerOwner, type OwnServerFacts } from "./own-home.ts";
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
});
