import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { personOf } from "../replies.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { cleanDisplayName, createPersonNames } from "./person-names.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-person-names-")); dirs.push(dir); return dir; };

describe("a name a person chooses on a self-hosted server", () => {
  it("is trimmed, 1 to 60 characters, and never holds a control character", () => {
    expect(cleanDisplayName("  Grace Hopper ")).toBe("Grace Hopper");
    expect(cleanDisplayName("   ")).toBeNull();
    expect(cleanDisplayName("x".repeat(60))).toBe("x".repeat(60));
    expect(cleanDisplayName("x".repeat(61))).toBeNull();
    expect(cleanDisplayName("😀".repeat(60)), "counted in characters, not UTF-16 units").toBe("😀".repeat(60));
    expect(cleanDisplayName("Grace\nHopper")).toBeNull();
    expect(cleanDisplayName("Grace\u0007")).toBeNull();
    expect(cleanDisplayName("José Ñúñez")).toBe("José Ñúñez");
  });

  it("belongs to the address on every device signed in with it, or to the one device without one", () => {
    const names = createPersonNames(dataDir());
    names.save({ id: "laptop", email: "Grace@Example.test" }, "Grace");
    expect(names.of({ id: "phone", email: "grace@example.test" })).toBe("Grace");
    names.save({ id: "tablet" }, "Ada");
    expect(names.of({ id: "tablet" })).toBe("Ada");
    expect(names.of({ id: "other-device" })).toBeNull();
    expect(names.byKey(personKey({ id: "tablet" }))).toBe("Ada");
    expect(names.byKey(undefined)).toBeNull();
    names.save({ id: "tablet" }, null);
    expect(names.of({ id: "tablet" })).toBeNull();
  });

  it("is kept in a file only its owner can read, and read back on the next start", () => {
    const dir = dataDir();
    createPersonNames(dir).save({ id: "s1", email: "grace@example.test" }, "Grace");
    const file = join(dir, "person-names.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(JSON.parse(readFileSync(file, "utf8")))).not.toContain("grace@example.test");
    expect(createPersonNames(dir).of({ id: "s2", email: "grace@example.test" })).toBe("Grace");
  });

  it("drops a name in the file that would not be accepted now", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "person-names.json"), JSON.stringify({ v: 1, names: { [personKey({ id: "a" })]: "Bad\u0000", [personKey({ id: "b" })]: 7 } }));
    const names = createPersonNames(dir);
    expect(names.of({ id: "a" })).toBeNull();
    expect(names.of({ id: "b" })).toBeNull();
  });

  it("names each line in a turn by its sender's chosen name, and every other line by the profile's", () => {
    const names = createPersonNames(dataDir());
    expect(names.lineNames("Ada Lovelace")).toBe("Ada Lovelace");
    names.save({ id: "s1", email: "grace@example.test" }, "Grace");
    const lineNames = names.lineNames("Ada Lovelace");
    expect(personOf(lineNames, { sender: { name: "Grace", id: personKey({ id: "", email: "grace@example.test" }) } })).toBe("Grace");
    expect(personOf(lineNames, { sender: { name: "Chrome on Mac", id: personKey({ id: "s9" }) } })).toBe("Ada Lovelace");
    expect(personOf(lineNames, {})).toBe("Ada Lovelace");
  });
});
