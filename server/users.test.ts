import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { roleScopes, UserError, UserRegistry } from "./users.ts";

let dir: string;
let clock: number;
let registry: UserRegistry;
const file = () => join(dir, "users.json");
const open = () => new UserRegistry({ file: file(), now: () => clock });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-users-"));
  clock = 1_700_000_000_000;
  registry = open();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const admin = (name = "Ada") => registry.create({ name, role: "admin" }, null);
const member = (name = "Bob") => registry.create({ name, role: "member" }, null);

describe("the roster", () => {
  it("starts empty when there is no file, which is the pre-RBAC state", () => {
    expect(registry.isEmpty()).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(registry.notice()).toBeNull();
  });

  it("writes 0600 and reloads identically", () => {
    const ada = registry.create({ name: "Ada Lovelace", email: "Ada@Example.COM", role: "admin" }, null);
    expect(JSON.parse(readFileSync(file(), "utf8")).version).toBe(1);
    // Windows does not carry POSIX modes.
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    const reopened = open();
    expect(reopened.list()).toEqual([ada]);
    expect(reopened.find(ada.id)?.name).toBe("Ada Lovelace");
  });

  it("lowercases email, treats blank as absent, and keeps it unique case-insensitively", () => {
    const ada = admin();
    expect(registry.update(ada.id, { email: "  Ada@Example.COM " })?.email).toBe("ada@example.com");
    expect(registry.findByEmail("ADA@EXAMPLE.COM")?.id).toBe(ada.id);
    expect(() => registry.create({ name: "Impostor", email: "ada@EXAMPLE.com" }, null)).toThrow(/already in use/);
    // Its own address is not a clash with itself.
    expect(registry.update(ada.id, { email: "ada@example.com" })?.email).toBe("ada@example.com");
    expect(registry.create({ name: "No Email", email: "   " }, null).email).toBeNull();
  });

  it("refuses a name or address it cannot store", () => {
    expect(() => registry.create({ name: "   " }, null)).toThrow(/1 to 80/);
    expect(() => registry.create({ name: "x".repeat(81) }, null)).toThrow(/1 to 80/);
    expect(() => registry.create({ name: "Bad", email: "not-an-address" }, null)).toThrow(/valid address/);
    const bob = member();
    expect(() => registry.update(bob.id, { name: "" })).toThrow(/1 to 80/);
    expect(registry.update("no-such-id", { name: "Ghost" })).toBeNull();
    expect(registry.remove("no-such-id")).toBe(false);
  });

  it("records who created whom, and stamps updatedAt", () => {
    const ada = admin();
    const bob = registry.create({ name: "Bob" }, ada.id);
    expect(bob.createdBy).toBe(ada.id);
    expect(bob.role).toBe("member"); // the default
    expect(ada.createdBy).toBeNull(); // loopback
    clock += 5_000;
    expect(registry.update(bob.id, { name: "Bob B." })?.updatedAt).toBe(clock);
  });
});

describe("roles", () => {
  it("projects onto today's two scopes", () => {
    expect(roleScopes("admin")).toEqual(["admin", "client"]);
    expect(roleScopes("member")).toEqual(["client"]);
  });
});

describe("the last active admin (guard A)", () => {
  it("cannot be demoted, disabled or removed", () => {
    const ada = admin();
    member(); // a member is not an admin, so it does not help
    for (const patch of [{ role: "member" as const }, { status: "disabled" as const }]) {
      expect(() => registry.update(ada.id, patch)).toThrow(/last active admin/);
    }
    expect(() => registry.remove(ada.id)).toThrow(/last active admin/);
    expect(registry.find(ada.id)?.role).toBe("admin");
    expect(registry.find(ada.id)?.status).toBe("active");
  });

  it("a second active admin unblocks all three", () => {
    const ada = admin("Ada");
    const ben = admin("Ben");
    expect(registry.update(ada.id, { status: "disabled" })?.status).toBe("disabled");
    // Ben is now the last one, and a disabled Ada does not count.
    expect(() => registry.update(ben.id, { role: "member" })).toThrow(/last active admin/);
    // Re-enabling Ada frees Ben again.
    registry.update(ada.id, { status: "active" });
    expect(registry.update(ben.id, { role: "member" })?.role).toBe("member");
    expect(registry.remove(ben.id)).toBe(true);
  });

  it("lets an unrelated edit through on the last admin", () => {
    const ada = admin();
    expect(registry.update(ada.id, { name: "Ada L." })?.name).toBe("Ada L.");
    expect(registry.update(ada.id, { role: "admin", status: "active" })?.role).toBe("admin");
  });
});

describe("disabling", () => {
  it("keeps the record so re-enabling restores it, and it stays findable", () => {
    admin(); // keeps guard A happy
    const bob = member();
    expect(registry.update(bob.id, { status: "disabled" })?.status).toBe("disabled");
    // Still findable: the auth path needs to say *why* it refused.
    expect(registry.find(bob.id)?.status).toBe("disabled");
    expect(registry.list()).toHaveLength(2);
    expect(registry.update(bob.id, { status: "active" })?.status).toBe("active");
  });
});

describe("an unreadable file", () => {
  const corrupt = (contents: string) => {
    writeFileSync(file(), contents);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const reopened = open();
    warn.mockRestore();
    return reopened;
  };

  it("serves nobody, says so, and — above all — never overwrites the evidence", () => {
    admin();
    const original = readFileSync(file(), "utf8");
    for (const contents of ["{ this is not json", JSON.stringify({ version: 2, users: [] }), JSON.stringify({ version: 1, users: [{ id: "x" }] })]) {
      const broken = corrupt(contents);
      expect(broken.isEmpty()).toBe(true);
      expect(broken.notice()).toMatch(/could not be read/);
      // Every write path refuses rather than clobbering the file.
      expect(() => broken.create({ name: "New" }, null)).toThrow(UserError);
      expect(readFileSync(file(), "utf8")).toBe(contents);
    }
    // And a repaired file loads normally on the next start.
    writeFileSync(file(), original);
    expect(open().notice()).toBeNull();
    expect(open().list()).toHaveLength(1);
  });
});
