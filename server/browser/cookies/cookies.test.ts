import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { importCookies, type CookieSink } from "./importer.ts";
import { googleCookie, importSite, writable, type WritableCookie } from "./policy.ts";
import { decryptChromium, deriveCbcKey, readChromium } from "./readers.ts";
import { chromiumKey, firefoxProfiles, keyStoreFor, listSources, locate, systemKeyStore, TEST_COOKIE_KEY_ENV } from "./sources.ts";
import { binaryCookies, chromiumDatabase, fakeKeys, firefoxProfile, fixtureFiles, gcmValue, localState } from "./testing/fixtures.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });
const home = () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-cookie-import-"));
  folders.push(folder);
  return folder;
};

// Encrypted by Python's hashlib (PBKDF2) and the OpenSSL command line (AES-128-CBC, IV of 16 spaces), not by the code
// under test: macOS (1003 rounds, the host's digest in front), Linux v10 ("peanuts", 1 round, no digest) and v11.
const MAC_PASSWORD = "fixture-safe-storage-password";
const MAC_VALUE = Buffer.from("76313054cf36b9ef61400c5e10dda32d23ed80240ac72f6ee76fd804a6509492e85a1e1984c1bd0148007d8ef65f218cfb46ec2fff34bb4f089089e5cc44a474e70d0b", "hex");
const LINUX_V10 = Buffer.from("763130de80b475a05bf7a01e53e70781dbf6d5", "hex");
const LINUX_V11 = Buffer.from("763131f17dc4093744be3d8576d56252e2b064ef557d8d7769580dfecded47bc6059248235ea94fa6c0d103cd1ad7032f21675", "hex");

const NOW = 1_800_000_000;
const LATER = NOW + 86_400 * 30;

class RecordingSink implements CookieSink {
  readonly written: WritableCookie[] = [];
  async write(cookies: WritableCookie[]) {
    this.written.push(...cookies);
    return { written: cookies.length, refused: 0 };
  }
}

function macChrome(folder: string, rows: Parameters<typeof chromiumDatabase>[1]) {
  const root = join(folder, "Library", "Application Support", "Google", "Chrome");
  localState(root, { Default: "Person", "Profile 1": "Work", "Profile 9": "No cookies" });
  chromiumDatabase(join(root, "Default", "Network", "Cookies"), rows).close();
  chromiumDatabase(join(root, "Profile 1", "Cookies"), []).close();
  return root;
}

describe("decrypting Chromium cookie values", () => {
  it("reads values encrypted outside this code, on macOS and Linux", () => {
    expect(decryptChromium(MAC_VALUE, { type: "cbc", v10: deriveCbcKey(MAC_PASSWORD, 1003), v11: null }, ".example.com")).toEqual({ value: "mac-session-value" });
    const linux = { type: "cbc" as const, v10: deriveCbcKey("peanuts", 1), v11: deriveCbcKey("fixture-keyring-password", 1) };
    expect(decryptChromium(LINUX_V10, linux, "example.com")).toEqual({ value: "linux-value" });
    expect(decryptChromium(LINUX_V11, linux, ".example.com")).toEqual({ value: "keyring-value" });
    expect(decryptChromium(LINUX_V11, { ...linux, v11: null }, ".example.com")).toEqual({ error: "failed" });
    expect(decryptChromium(MAC_VALUE, linux, ".example.com")).toEqual({ error: "failed" });
  });

  it("reads Windows' AES-GCM values with and without the host's digest, and leaves app-bound ones alone", () => {
    const key = randomBytes(32);
    expect(decryptChromium(gcmValue(key, ".example.com", "win-value"), { type: "gcm", key }, ".example.com")).toEqual({ value: "win-value" });
    expect(decryptChromium(gcmValue(key, ".example.com", "old-value", false), { type: "gcm", key }, ".example.com")).toEqual({ value: "old-value" });
    expect(decryptChromium(gcmValue(randomBytes(32), "a.test", "x"), { type: "gcm", key }, "a.test")).toEqual({ error: "failed" });
    expect(decryptChromium(Buffer.from(`v20${"a".repeat(40)}`), { type: "gcm", key }, "a.test")).toEqual({ error: "protected" });
  });

  it("unwraps a Windows profile's key from Local State through DPAPI, and says when there is none to unwrap", async () => {
    const folder = home();
    const root = join(folder, "Local", "Google", "Chrome", "User Data");
    const key = randomBytes(32);
    localState(root, { Default: "Person" }, Buffer.from("dpapi-wrapped"));
    chromiumDatabase(join(root, "Default", "Network", "Cookies"), []).close();
    const files = fixtureFiles(folder, "win32", { env: { LOCALAPPDATA: join(folder, "Local") } });
    // win32 paths over a POSIX fixture folder: only the key's lookup goes through the BrowserFiles here.
    const located = { source: { id: "chrome", name: "Google Chrome", engine: "chromium" as const, root }, profile: { id: "Default", name: "Person", directory: join(root, "Default"), cookies: join(root, "Default", "Network", "Cookies") } };
    const keys = fakeKeys({ windows: key });
    expect(await chromiumKey(files, located, keys)).toEqual({ type: "gcm", key });
    expect(keys.asked).toEqual(["windows:13"]);
    localState(root, { Default: "Person" });
    await expect(chromiumKey(files, located, keys)).rejects.toThrow(/keeps no key/);
  });
});

describe("listing another browser's profiles", () => {
  it("names browsers and profiles from Local State and profiles.ini only, and offers Safari on macOS without looking inside it", async () => {
    const folder = home();
    macChrome(folder, []);
    firefoxProfile(join(folder, "Library", "Application Support", "Firefox"), "Profiles/abc.default", "default-release", []);
    const sources = await listSources(fixtureFiles(folder, "darwin", { safari: true }));
    expect(sources).toEqual([
      { id: "chrome", name: "Google Chrome", engine: "chromium", profiles: [{ id: "Default", name: "Person" }, { id: "Profile 1", name: "Work" }] },
      { id: "safari", name: "Safari", engine: "safari", profiles: [{ id: "default", name: "Default" }] },
      { id: "firefox", name: "Firefox", engine: "firefox", profiles: [{ id: "Profiles/abc.default", name: "default-release" }] },
    ]);
    expect(await listSources(fixtureFiles(folder, "darwin"))).toHaveLength(2);
  });

  it("never takes a path from a profile file that climbs out of the browser's folder", () => {
    expect(firefoxProfiles("/r", "[Profile0]\nName=a\nIsRelative=1\nPath=../../etc\n[Profile1]\nName=b\nIsRelative=1\nPath=Profiles/x\n")).toEqual([{ id: "Profiles/x", name: "b", directory: "/r/Profiles/x" }]);
  });
});

describe("importing one site", () => {
  const request = (folder: string, platform: NodeJS.Platform, keys: ReturnType<typeof fakeKeys>, overrides: Partial<Parameters<typeof importCookies>[0]> = {}) => ({
    files: fixtureFiles(folder, platform, { safari: true }), keys, scratch: join(folder, "scratch"), source: "chrome", profile: "Default", site: "example.com",
    sink: new RecordingSink(), now: NOW, ...overrides,
  });

  it("brings a macOS Chrome profile's sign-in for one site, with its attributes, and nothing of any other site", async () => {
    const folder = home();
    macChrome(folder, [
      { host: ".example.com", name: "session", encrypted: MAC_VALUE, expires: LATER, secure: true, httpOnly: true, sameSite: 1 },
      { host: "app.example.com", name: "plain", value: "visible", path: "/app", expires: LATER, sameSite: 2 },
      { host: "example.com", name: "temp", value: "for-now", expires: 0 },
      { host: ".example.com", name: "old", value: "gone", expires: NOW - 10 },
      { host: ".example.com", name: "chips", value: "p", expires: LATER, secure: true, partition: "https://other.test" },
      { host: ".example.com", name: "loose", value: "n", expires: LATER, sameSite: 0 },
      { host: ".example.com", name: "__Host-id", value: "h", expires: LATER, secure: true },
      // Another site's value is never read: this one would not even decrypt.
      { host: ".other.test", name: "x", encrypted: Buffer.from("v10broken"), expires: LATER },
      { host: "notexample.com", name: "x", value: "y", expires: LATER },
    ]);
    const keys = fakeKeys({ mac: MAC_PASSWORD });
    const sink = new RecordingSink();
    const result = await importCookies(request(folder, "darwin", keys, { sink }));
    expect(result).toEqual({ ok: true, site: "example.com", imported: 3, sessionOnly: 1, skipped: { expired: 1, partitioned: 1, "insecure-none": 1, "host-prefix": 1 } });
    expect(keys.asked).toEqual(["mac:Chrome Safe Storage:Chrome"]);
    expect(sink.written).toEqual([
      { url: "https://example.com/", name: "session", value: "mac-session-value", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: LATER },
      { url: "http://app.example.com/app", name: "plain", value: "visible", path: "/app", secure: false, httpOnly: false, sameSite: "strict", expirationDate: LATER },
      { url: "http://example.com/", name: "temp", value: "for-now", path: "/", secure: false, httpOnly: false, sameSite: "unspecified" },
    ]);
    expect(readdirSync(join(folder, "scratch"))).toEqual([]);
  });

  it("never imports Google, and says so instead of asking for a key", async () => {
    const folder = home();
    macChrome(folder, [{ host: ".google.com", name: "SID", value: "s", expires: LATER }]);
    const keys = fakeKeys({ mac: MAC_PASSWORD });
    expect(await importCookies(request(folder, "darwin", keys, { site: "accounts.google.com" }))).toEqual({ ok: false, reason: "google" });
    expect(keys.asked).toEqual([]);
    expect(googleCookie(".google.com", "anything")).toBe(true);
    expect(googleCookie("mail.google.com", "x")).toBe(true);
    expect(googleCookie(".youtube.com", "SID")).toBe(false);
    expect(googleCookie(".notgoogle.com", "SIDCC")).toBe(false);
  });

  it("refuses what is not one site", async () => {
    const folder = home();
    for (const site of ["github.io", "com", "co.uk", "127.0.0.1", "localhost", "javascript:alert(1)", ""]) {
      expect(importSite(site), site).toBeNull();
      expect(await importCookies(request(folder, "darwin", fakeKeys({}), { site }))).toEqual({ ok: false, reason: "not-a-site" });
    }
    expect(importSite("https://App.GitHub.com/x")).toBe("github.com");
    expect(importSite("me.github.io")).toBe("me.github.io");
    expect(importSite("shop.example.co.uk")).toBe("example.co.uk");
  });

  it("says plainly when the person turns the Keychain down, and nothing of a value reaches a log or an error", async () => {
    const folder = home();
    macChrome(folder, [{ host: ".example.com", name: "session", encrypted: MAC_VALUE, expires: LATER }, { host: ".example.com", name: "plain", value: "secret-plain-value", expires: LATER }]);
    const lines: string[] = [];
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    try {
      const denied = await importCookies(request(folder, "darwin", fakeKeys({ mac: null }), { log: (line) => lines.push(line) }));
      expect(denied).toEqual({ ok: false, reason: "key-denied" });
      const done = await importCookies(request(folder, "darwin", fakeKeys({ mac: MAC_PASSWORD }), { log: (line) => lines.push(line) }));
      expect(done.ok).toBe(true);
      const said = JSON.stringify([lines, denied, done]);
      for (const value of ["mac-session-value", "secret-plain-value", MAC_PASSWORD]) expect(said).not.toContain(value);
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      for (const spy of consoles) spy.mockRestore();
    }
  });

  it("reads a database the browser still has open, from a copy with its write-ahead log, and deletes the copy", async () => {
    const folder = home();
    const root = join(folder, "Library", "Application Support", "Google", "Chrome");
    localState(root, { Default: "Person" });
    const scratch = join(folder, "scratch");
    mkdirSync(join(scratch, "copy-left-by-a-crash"), { recursive: true });
    writeFileSync(join(scratch, "copy-left-by-a-crash", "Cookies"), "old copy");
    // Still open, in WAL mode, never checkpointed: the rows live only in Cookies-wal.
    const live = chromiumDatabase(join(root, "Default", "Network", "Cookies"), [{ host: ".example.com", name: "wal", value: "in-the-log", expires: LATER }], { wal: true });
    try {
      const sink = new RecordingSink();
      const result = await importCookies(request(folder, "darwin", fakeKeys({ mac: MAC_PASSWORD }), { sink }));
      expect(result.ok).toBe(true);
      expect(sink.written.map((cookie) => cookie.name)).toEqual(["wal"]);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("imports from Linux Chromium with Chromium's fixed password and the keyring's, asking the keyring by the browser's name", async () => {
    const folder = home();
    const root = join(folder, ".config", "google-chrome");
    localState(root, { Default: "Person" });
    chromiumDatabase(join(root, "Default", "Cookies"), [
      { host: "example.com", name: "v10", encrypted: LINUX_V10, expires: LATER },
      { host: ".example.com", name: "v11", encrypted: LINUX_V11, expires: LATER },
    ]).close();
    const keys = fakeKeys({ linux: "fixture-keyring-password" });
    const sink = new RecordingSink();
    expect(await importCookies(request(folder, "linux", keys, { sink }))).toMatchObject({ ok: true, imported: 2 });
    expect(sink.written.map((cookie) => cookie.value)).toEqual(["linux-value", "keyring-value"]);
    expect(keys.asked).toEqual(["linux:chrome"]);
  });

  it("says the sign-in could not be read when no value decrypts, not that the site has none", async () => {
    const folder = home();
    macChrome(folder, [{ host: ".example.com", name: "session", encrypted: MAC_VALUE, expires: LATER }]);
    expect(await importCookies(request(folder, "darwin", fakeKeys({ mac: "a-changed-password" })))).toEqual({ ok: false, reason: "unreadable" });
    expect(await importCookies(request(folder, "darwin", fakeKeys({ mac: MAC_PASSWORD }), { site: "nowhere.test" }))).toEqual({ ok: false, reason: "nothing-found" });
  });

  it("says a browser's app-bound encryption keeps its cookies to itself", async () => {
    const folder = home();
    const root = join(folder, ".config", "google-chrome");
    localState(root, { Default: "Person" });
    chromiumDatabase(join(root, "Default", "Cookies"), [{ host: ".example.com", name: "a", encrypted: Buffer.from(`v20${"x".repeat(40)}`), expires: LATER }]).close();
    expect(await importCookies(request(folder, "linux", fakeKeys({})))).toEqual({ ok: false, reason: "app-bound" });
  });

  it("imports from Firefox's default container only", async () => {
    const folder = home();
    firefoxProfile(join(folder, ".mozilla", "firefox"), "abc.default", "default", [
      { host: ".example.com", name: "ff", value: "fox", expiry: LATER * 1000, secure: true, sameSite: 0 },
      { host: ".example.com", name: "work", value: "container", expiry: LATER, originAttributes: "^userContextId=2" },
      { host: ".other.test", name: "x", value: "y", expiry: LATER },
    ]);
    const sink = new RecordingSink();
    const result = await importCookies(request(folder, "linux", fakeKeys({}), { source: "firefox", profile: "abc.default", sink }));
    expect(result).toMatchObject({ ok: true, imported: 1 });
    expect(sink.written).toEqual([{ url: "https://example.com/", name: "ff", value: "fox", domain: ".example.com", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction", expirationDate: LATER }]);
  });

  it("reads Safari's binarycookies, and names Full Disk Access when macOS refuses the file", async () => {
    const folder = home();
    const file = join(folder, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, binaryCookies([
      { host: ".example.com", name: "safari", value: "apple", expires: LATER, secure: true, httpOnly: true },
      { host: ".other.test", name: "x", value: "y", expires: LATER },
    ]));
    const sink = new RecordingSink();
    expect(await importCookies(request(folder, "darwin", fakeKeys({}), { source: "safari", profile: "default", sink }))).toMatchObject({ ok: true, imported: 1 });
    expect(sink.written).toEqual([{ url: "https://example.com/", name: "safari", value: "apple", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "unspecified", expirationDate: LATER }]);
    // Windows has no mode bits that refuse the file's owner, and Safari's file only exists on a Mac.
    if (process.platform === "win32") return;
    chmodSync(file, 0o000);
    try {
      expect(await importCookies(request(folder, "darwin", fakeKeys({}), { source: "safari", profile: "default" }))).toEqual({ ok: false, reason: "full-disk-access" });
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("finds only profiles the listing offers, never a path a caller names", async () => {
    const folder = home();
    macChrome(folder, []);
    const files = fixtureFiles(folder, "darwin");
    expect(await locate(files, "chrome", "../../Library")).toBeNull();
    expect(await locate(files, "chrome", "Profile 9")).toBeNull();
    expect(await importCookies(request(folder, "darwin", fakeKeys({}), { profile: "/etc" }))).toEqual({ ok: false, reason: "no-source" });
  });
});

describe("the cookies a bot's browser can take", () => {
  it("skips what a browser would refuse or could not keep, and maps the rest", () => {
    const base = { host: ".example.com", name: "n", value: "v", path: "/", secure: true, httpOnly: false, expires: LATER, sameSite: "lax" as const };
    expect(writable({ ...base, name: "__Secure-x", secure: false }, NOW)).toEqual({ skip: "secure-prefix" });
    expect(writable({ ...base, host: "example.com", name: "__Host-x" }, NOW)).toMatchObject({ name: "__Host-x" });
    expect(writable({ ...base, name: "", value: "" }, NOW)).toEqual({ skip: "empty" });
    expect(writable({ ...base, host: ".mail.google.com" }, NOW)).toEqual({ skip: "google" });
    expect(writable({ ...base, path: "x" }, NOW)).toMatchObject({ path: "/" });
  });
});

describe("the system key stores", () => {
  it("answer a live test's fixture password without ever calling a system tool, and only where it is set", async () => {
    const calls: string[] = [];
    const run = async (command: string) => { calls.push(command); return "system\n"; };
    const fixture = keyStoreFor({ [TEST_COOKIE_KEY_ENV]: "fixture-password" }, run);
    expect(await fixture.macPassword("Chrome Safe Storage", "Chrome")).toBe("fixture-password");
    expect(await fixture.linuxPassword("chrome")).toBe("fixture-password");
    await expect(fixture.windowsUnprotect(Buffer.from("blob"))).rejects.toThrow(/DPAPI/);
    expect(calls).toEqual([]);
    expect(await keyStoreFor({}, run).macPassword("Chrome Safe Storage", "Chrome")).toBe("system\n");
    expect(calls).toEqual(["/usr/bin/security"]);
    // The packaged app never hands the fixture key to its server.
    const main = readFileSync(new URL("../../../electron/main.mjs", import.meta.url), "utf8");
    expect(main).toContain(`if (app.isPackaged) delete childEnv.${TEST_COOKIE_KEY_ENV};`);
  });

  it("ask each system's own tool by its absolute path, with nothing from a caller in a shell", async () => {
    const calls: Array<[string, readonly string[], string | undefined]> = [];
    const run = async (command: string, args: readonly string[], input?: string) => {
      calls.push([command, args, input]);
      if (command.endsWith("powershell.exe")) return Buffer.from("key").toString("base64");
      return command.includes("secret-tool") ? "" : "password\n";
    };
    const keys = systemKeyStore({ SystemRoot: "C:\\Windows" }, run);
    expect(await keys.macPassword("Chrome Safe Storage", "Chrome")).toBe("password\n");
    expect(await keys.windowsUnprotect(Buffer.from("blob"))).toEqual(Buffer.from("key"));
    expect(await keys.linuxPassword("chrome")).toBeNull();
    expect(calls.map(([command, args]) => [command, args[0]])).toEqual([
      ["/usr/bin/security", "find-generic-password"],
      ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile"],
      ["/usr/bin/secret-tool", "lookup"],
      ["/bin/secret-tool", "lookup"],
    ]);
    expect(calls[1]![2]).toBe(Buffer.from("blob").toString("base64"));
  });
});

describe("reading Chromium's table", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for the key only when a row of the site is encrypted", async () => {
    const folder = home();
    const file = join(folder, "Cookies");
    chromiumDatabase(file, [{ host: ".example.com", name: "plain", value: "v", expires: LATER }, { host: ".other.test", name: "x", encrypted: MAC_VALUE }]).close();
    const key = vi.fn(async () => ({ type: "cbc" as const, v10: deriveCbcKey(MAC_PASSWORD, 1003), v11: null }));
    const read = await readChromium(file, join(folder, "scratch"), "example.com", key);
    expect(read.cookies.map((cookie) => cookie.name)).toEqual(["plain"]);
    expect(key).not.toHaveBeenCalled();
  });
});

