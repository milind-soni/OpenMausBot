import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETTLED_MS, syncSignIn } from "./sign-ins.ts";

let root = "", team = "", bob = "", owner = "";
const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token } });
const write = (path: string, text: string, ageMs = 60_000) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
};
const files = () => ({ bob: { source: team, target: bob }, owner: { source: team, target: owner } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-sign-ins-"));
  team = join(root, "server", ".claude", ".credentials.json");
  bob = join(root, "bob", ".claude", ".credentials.json");
  owner = join(root, "owner", ".claude", ".credentials.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the team's sign-in in an audience's home", () => {
  it("is copied in, private to the server's user, and left alone while nothing changed", () => {
    write(team, credentials("tok-1"));
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-1"));
    if (process.platform !== "win32") expect(statSync(bob).mode & 0o077).toBe(0);
    expect(syncSignIn(files().bob)).toBe("same");
    // The team signs in again: every audience gets the new one.
    write(team, credentials("tok-2"), 1_000);
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-2"));
  });

  it("a refresh an engine wrote in one audience becomes the team's, in place, and reaches the others", () => {
    write(team, credentials("tok-1"));
    syncSignIn(files().bob);
    syncSignIn(files().owner);
    const inode = statSync(team).ino;
    write(bob, credentials("tok-1+"), SETTLED_MS + 500);
    expect(syncSignIn(files().owner, [bob])).toBe("taken back");
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-1+"));
    expect(statSync(team).ino).toBe(inode);
    expect(readFileSync(owner, "utf8")).toBe(credentials("tok-1+"));
    expect(syncSignIn(files().bob, [owner])).toBe("same");
  });

  it("a shorter refresh replaces the whole team's file, in place", () => {
    write(team, credentials("tok-1-long-access-token"));
    syncSignIn(files().bob);
    const inode = statSync(team).ino;
    write(bob, credentials("tok-2"), SETTLED_MS + 500);
    expect(syncSignIn(files().owner, [bob])).toBe("taken back");
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-2"));
    expect(statSync(team).ino).toBe(inode);
    expect(readFileSync(owner, "utf8")).toBe(credentials("tok-2"));
  });

  it("a copy still being written, or one that does not read whole, is never taken back", () => {
    write(team, credentials("tok-1"));
    syncSignIn(files().bob);
    write(bob, credentials("tok-1+"), 0);
    expect(syncSignIn(files().bob)).toBe("same");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-1+"));
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-1"));
    write(bob, '{"claudeAiOauth": {"accessTo', SETTLED_MS + 500);
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-1"));
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-1"));
  });

  it("goes when the team signs out, and a link or folder where the copy belongs is replaced by a copy", () => {
    write(team, credentials("tok-1"));
    syncSignIn(files().bob);
    rmSync(team);
    expect(syncSignIn(files().bob)).toBe("removed");
    expect(existsSync(bob)).toBe(false);
    write(team, credentials("tok-3"));
    if (process.platform !== "win32") {
      symlinkSync(join(root, "elsewhere"), bob);
      expect(syncSignIn(files().bob)).toBe("copied");
      expect(lstatSync(bob).isFile()).toBe(true);
    }
    rmSync(bob, { force: true });
    mkdirSync(bob, { recursive: true });
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-3"));
  });
});
