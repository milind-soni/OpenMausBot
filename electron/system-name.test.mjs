// A first run's default profile name: the full name on this computer's own account, never a login or a generic one.
import { describe, expect, it } from "vitest";
import { accountFullName, systemFullName } from "./system-name.mjs";

describe("the name a first run greets someone by", () => {
  it("takes the account's full name, up to the first comma, kept to 100 characters", () => {
    expect(systemFullName("Ada Lovelace", "ada")).toBe("Ada Lovelace");
    expect(systemFullName("  Ada Lovelace,Room 4,,  ", "ada")).toBe("Ada Lovelace");
    expect(systemFullName("A".repeat(140), "ada")).toHaveLength(100);
  });

  it("never takes the login's short name, an address, digits or a generic account name", () => {
    expect(systemFullName("ada", "ada")).toBeNull();
    expect(systemFullName("ADA", "ada")).toBeNull();
    expect(systemFullName("ada@example.com", "ada")).toBeNull();
    expect(systemFullName("Build Agent 2", "ci")).toBeNull();
    for (const generic of ["admin", "Administrator", "user", "Guest", "student", "owner", "root", "Test"]) expect(systemFullName(generic, "x")).toBeNull();
    expect(systemFullName("", "ada")).toBeNull();
    expect(systemFullName(null, "ada")).toBeNull();
  });

  it("asks macOS for id -F and Linux for the GECOS field; Windows gives none", async () => {
    const calls = [];
    const exec = async (file, args) => {
      calls.push([file, ...args]);
      return file === "/usr/bin/id" ? "Ada Lovelace\n" : "ada:x:1000:1000:Ada Lovelace,,,:/home/ada:/bin/bash\n";
    };
    expect(await accountFullName({ platform: "darwin", user: { username: "ada", uid: 501 }, exec })).toBe("Ada Lovelace");
    expect(await accountFullName({ platform: "linux", user: { username: "ada", uid: 1000 }, exec })).toBe("Ada Lovelace");
    expect(calls).toEqual([["/usr/bin/id", "-F"], ["getent", "passwd", "1000"]]);
    expect(await accountFullName({ platform: "win32", user: { username: "ada", uid: -1 }, exec })).toBeNull();
    expect(calls).toHaveLength(2);
  });
});
