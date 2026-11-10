import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lookForGrokBot, removeOldCursorSignIn } from "./grok-local.ts";
import { thisMachine, type SetupFs, type SetupMachine } from "./setup-import.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "omb-grok-home-"));
  homes.push(home);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
    return join(home, path);
  };
  return { home, put };
}

/** Records every file opened, for the pin that nothing else in Grok Bot's folders ever is. */
function machineAt(home: string, platform: NodeJS.Platform = "darwin"): SetupMachine & { opened: string[] } {
  const real = thisMachine();
  const opened: string[] = [];
  const fs: SetupFs = { ...real.fs, read: (path, ...rest) => {
    opened.push(path);
    return real.fs.read(path, ...rest);
  } };
  return { ...real, home, platform, env: {}, fs, opened };
}

const base32 = (text: string) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of Buffer.from(text)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits ? out + alphabet[(value << (5 - bits)) & 31] : out;
};
const CACHE = "Library/Application Support/Grok Bot/sand-client-persistence";
const slice = (kind: string) => `${CACHE}/${base32(`sand.client.slice.account.user%2E1.${kind}`)}.blob`;
const SECRET = "the-secret-chat-text-and-login";

function appCache(put: (path: string, text: string) => string) {
  put(slice("roster.last-roster"), JSON.stringify({ schemaVersion: 1, value: { rows: [
    { id: "b1", name: "Drew" }, { id: "b2", name: "dr eggbot" }, { id: "g1", name: "A group", isGroup: true },
  ] } }));
  // What must never be opened: chats, other slices and login material.
  return [
    put(slice("transcript.replicas.b1"), JSON.stringify({ schemaVersion: 1, value: { entries: [{ event: { type: "message", text: SECRET } }] } })),
    put(slice("settings.tokens"), SECRET),
    put(`${CACHE}/sand-secrets.json`, SECRET),
    put(`${CACHE}/${base32("sand-secrets")}.blob`, SECRET),
    put(`${CACHE}/notes.blob`, SECRET),
    put("Library/Application Support/Grok Bot/sand-secrets.json", SECRET),
    put("Library/Application Support/Grok Bot/Cookies", SECRET),
    put("Library/Application Support/Grok Bot/Local Storage/leveldb/000.log", SECRET),
    put(".grokbot/daemon.json", SECRET),
  ];
}

describe("what the desktop app finds about Grok Bot", () => {
  it("reads only the roster slice, never a chat or login material", () => {
    const { home, put } = fixtureHome();
    const never = appCache(put);
    const machine = machineAt(home);
    const look = lookForGrokBot(machine);
    expect(look.bots).toEqual(["Drew", "dr eggbot"]);
    expect(JSON.stringify(look)).not.toContain(SECRET);
    expect(machine.opened).toEqual([join(home, slice("roster.last-roster"))]);
    for (const path of never) expect(machine.opened).not.toContain(path);
  });

  it("works without the app, and with an unreadable or foreign cache", () => {
    const empty = fixtureHome();
    expect(lookForGrokBot(machineAt(empty.home))).toEqual({ files: [], bots: [] });
    const broken = fixtureHome();
    broken.put(slice("roster.last-roster"), "not json");
    expect(lookForGrokBot(machineAt(broken.home))).toEqual({ files: [], bots: [] });
    const foreign = fixtureHome();
    foreign.put(slice("roster.last-roster"), JSON.stringify({ value: { rows: "nope" } }));
    expect(lookForGrokBot(machineAt(foreign.home)).bots).toEqual([]);
  });

  it("finds only grok-bot-export files in Downloads, real files only, newest first", () => {
    const { home, put } = fixtureHome();
    const older = put("Downloads/grok-bot-export-drew.json", "older");
    put("Downloads/grok-bot-export (1).md", "newest");
    utimesSync(older, new Date(1_000), new Date(1_000));
    const other = put("Downloads/bank-statement.json", SECRET);
    const elsewhere = put("Documents/grok-bot-export-x.json", SECRET);
    const target = put("private.txt", SECRET);
    symlinkSync(target, join(home, "Downloads", "grok-bot-export-link.json"));
    put("Downloads/grok-bot-export-binary.exe", SECRET);
    const machine = machineAt(home);
    const look = lookForGrokBot(machine);
    expect(look.files.map((file) => file.name)).toEqual(["grok-bot-export (1).md", "grok-bot-export-drew.json"]);
    expect(look.files.map((file) => file.text)).toEqual(["newest", "older"]);
    for (const path of [other, elsewhere, target]) expect(machine.opened).not.toContain(path);
  });

  it("deletes an old Cursor sign-in, and minds nothing when there is none", () => {
    const { home, put } = fixtureHome();
    const token = put("data/cursor-session.json", SECRET);
    const kept = put("data/config.json", "{}");
    removeOldCursorSignIn(join(home, "data"));
    expect(existsSync(token)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(() => removeOldCursorSignIn(join(home, "data"))).not.toThrow();
  });
});
